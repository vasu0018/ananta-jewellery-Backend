import type { ShippingPartner } from "@prisma/client";
import { badRequest } from "../http";
import { num, randomDigits } from "../utils";
import { getSetting } from "../settings";
import {
  mapCourierStatus,
  type CreateShipmentRequest,
  type ShippingProvider,
  type TrackingResult,
} from "./types";

type Creds = Record<string, string | undefined>;
const creds = (p: ShippingPartner) => (p.credentials ?? {}) as Creds;

function tracking(partner: ShippingPartner, awb: string, fallback: string) {
  return (partner.trackingUrl || fallback).replace("{awb}", encodeURIComponent(awb));
}

async function http<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* non JSON */
  }
  if (!res.ok) {
    const msg = (data as { message?: string })?.message || text.slice(0, 200) || res.statusText;
    throw badRequest(`Courier API error (${res.status}): ${msg}`);
  }
  return data as T;
}

// ─────────────────────────── Manual / self-ship ──────────────────────────────

const manual: ShippingProvider = {
  code: "MANUAL",
  label: "Manual / Self ship",
  credentialFields: [],
  async createShipment(req) {
    const awb = req.awb?.trim() || `AJ${randomDigits(10)}`;
    return {
      awb,
      courierName: req.courierName?.trim() || "Ananta Express",
      trackingUrl: req.partner.trackingUrl?.replace("{awb}", awb),
      status: "CREATED",
    };
  },
  async track() {
    return null;
  },
};

// ─────────────────────────────── Shiprocket ──────────────────────────────────

const SR_BASE = "https://apiv2.shiprocket.in/v1/external";
const srTokens = new Map<string, { token: string; at: number }>();

async function srToken(partner: ShippingPartner) {
  const c = creds(partner);
  if (!c.email || !c.password) throw badRequest("Shiprocket email/password not configured");
  const hit = srTokens.get(partner.id);
  if (hit && Date.now() - hit.at < 8 * 24 * 3600 * 1000) return hit.token;
  const r = await http<{ token: string }>(`${SR_BASE}/auth/login`, { method: "POST", json: { email: c.email, password: c.password } });
  srTokens.set(partner.id, { token: r.token, at: Date.now() });
  return r.token;
}

const shiprocket: ShippingProvider = {
  code: "SHIPROCKET",
  label: "Shiprocket",
  credentialFields: [
    { key: "email", label: "API user email" },
    { key: "password", label: "API user password", secret: true },
    { key: "pickupLocation", label: "Pickup location nickname" },
    { key: "channelId", label: "Channel ID (optional)" },
  ],
  async testConnection(partner) {
    await srToken(partner);
    return "Authenticated with Shiprocket";
  },
  async createShipment({ order, partner, pkg }: CreateShipmentRequest) {
    const token = await srToken(partner);
    const c = creds(partner);
    const a = order.shippingAddress as Record<string, string>;
    const [first, ...rest] = (a.name || order.customerName).split(" ");
    const created = await http<{ order_id: number; shipment_id: number }>(`${SR_BASE}/orders/create/adhoc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      json: {
        order_id: order.orderNumber,
        order_date: order.placedAt.toISOString().slice(0, 16).replace("T", " "),
        pickup_location: c.pickupLocation || "Primary",
        channel_id: c.channelId || undefined,
        billing_customer_name: first,
        billing_last_name: rest.join(" ") || ".",
        billing_address: [a.line1, a.line2, a.landmark].filter(Boolean).join(", "),
        billing_city: a.city,
        billing_pincode: a.pincode,
        billing_state: a.state,
        billing_country: a.country || "India",
        billing_email: order.email,
        billing_phone: a.phone || order.phone,
        shipping_is_billing: true,
        order_items: order.items.map((i) => ({
          name: i.name,
          sku: i.sku,
          units: i.quantity,
          selling_price: num(i.unitPrice),
          hsn: 7113,
        })),
        payment_method: order.paymentMethod === "COD" ? "COD" : "Prepaid",
        sub_total: num(order.total),
        length: pkg.length,
        breadth: pkg.width,
        height: pkg.height,
        weight: Math.max(0.05, pkg.weightGrams / 1000),
      },
    });
    const awbRes = await http<{ response?: { data?: { awb_code?: string; courier_name?: string } } }>(`${SR_BASE}/courier/assign/awb`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      json: { shipment_id: created.shipment_id },
    });
    const awb = awbRes.response?.data?.awb_code;
    if (!awb) throw badRequest("Shiprocket did not assign an AWB. Check courier serviceability for this pincode.");
    let labelUrl: string | undefined;
    try {
      const label = await http<{ label_url?: string }>(`${SR_BASE}/courier/generate/label`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        json: { shipment_id: [created.shipment_id] },
      });
      labelUrl = label.label_url;
    } catch {
      /* label can be generated later */
    }
    return {
      awb,
      courierName: awbRes.response?.data?.courier_name || "Shiprocket",
      providerShipmentId: String(created.shipment_id),
      labelUrl,
      trackingUrl: tracking(partner, awb, "https://shiprocket.co/tracking/{awb}"),
      status: "CREATED",
    };
  },
  async schedulePickup(providerShipmentId, partner) {
    const token = await srToken(partner);
    await http(`${SR_BASE}/courier/generate/pickup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      json: { shipment_id: [Number(providerShipmentId)] },
    });
  },
  async track(awb, partner): Promise<TrackingResult | null> {
    const token = await srToken(partner);
    const r = await http<{
      tracking_data?: {
        shipment_track?: { current_status?: string }[];
        shipment_track_activities?: { date: string; activity: string; location?: string }[];
      };
    }>(`${SR_BASE}/courier/track/awb/${encodeURIComponent(awb)}`, { headers: { Authorization: `Bearer ${token}` } });
    const td = r.tracking_data;
    if (!td) return null;
    const events = (td.shipment_track_activities ?? []).map((e) => ({
      status: mapCourierStatus(e.activity),
      location: e.location,
      note: e.activity,
      occurredAt: new Date(e.date),
    }));
    const current = td.shipment_track?.[0]?.current_status ?? events[0]?.note ?? "In transit";
    const status = mapCourierStatus(current);
    return { status, events, ndrReason: status === "NDR" ? current : undefined };
  },
  async cancel(awb, partner) {
    const token = await srToken(partner);
    await http(`${SR_BASE}/orders/cancel/shipment/awbs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      json: { awbs: [awb] },
    });
  },
};

// ─────────────────────────────── Delhivery ───────────────────────────────────

const dlBase = (p: ShippingPartner) => (p.mode === "LIVE" ? "https://track.delhivery.com" : "https://staging-express.delhivery.com");

const delhivery: ShippingProvider = {
  code: "DELHIVERY",
  label: "Delhivery",
  credentialFields: [
    { key: "token", label: "API token", secret: true },
    { key: "pickupLocation", label: "Registered pickup location name" },
    { key: "clientName", label: "Client name" },
  ],
  async testConnection(partner) {
    const c = creds(partner);
    if (!c.token) throw badRequest("Delhivery API token not configured");
    await http(`${dlBase(partner)}/c/api/pin-codes/json/?filter_codes=110001`, { headers: { Authorization: `Token ${c.token}` } });
    return "Delhivery API token is valid";
  },
  async createShipment({ order, partner, pkg }) {
    const c = creds(partner);
    if (!c.token) throw badRequest("Delhivery API token not configured");
    const store = await getSetting("store");
    const a = order.shippingAddress as Record<string, string>;
    const payload = {
      shipments: [
        {
          name: a.name || order.customerName,
          add: [a.line1, a.line2, a.landmark].filter(Boolean).join(", "),
          pin: a.pincode,
          city: a.city,
          state: a.state,
          country: "India",
          phone: a.phone || order.phone,
          order: order.orderNumber,
          payment_mode: order.paymentMethod === "COD" ? "COD" : "Prepaid",
          cod_amount: order.paymentMethod === "COD" ? num(order.total) : 0,
          total_amount: num(order.total),
          products_desc: order.items.map((i) => i.name).join(", ").slice(0, 200),
          quantity: order.items.reduce((s, i) => s + i.quantity, 0),
          weight: pkg.weightGrams,
          shipment_length: pkg.length,
          shipment_width: pkg.width,
          shipment_height: pkg.height,
          seller_name: store.name,
          seller_add: store.address,
          hsn_code: "7113",
        },
      ],
      pickup_location: { name: c.pickupLocation || store.name },
    };
    const body = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
    const r = await http<{ success?: boolean; packages?: { waybill?: string; status?: string; remarks?: string[] }[]; rmk?: string }>(
      `${dlBase(partner)}/api/cmu/create.json`,
      { method: "POST", headers: { Authorization: `Token ${c.token}`, "Content-Type": "application/x-www-form-urlencoded" }, body },
    );
    const pkgRes = r.packages?.[0];
    if (!pkgRes?.waybill) throw badRequest(`Delhivery: ${pkgRes?.remarks?.join(", ") || r.rmk || "failed to create shipment"}`);
    return {
      awb: pkgRes.waybill,
      courierName: "Delhivery",
      labelUrl: `${dlBase(partner)}/api/p/packing_slip?wbns=${pkgRes.waybill}&pdf=true`,
      trackingUrl: tracking(partner, pkgRes.waybill, "https://www.delhivery.com/track/package/{awb}"),
      status: "CREATED",
    };
  },
  async track(awb, partner) {
    const c = creds(partner);
    if (!c.token) throw badRequest("Delhivery API token not configured");
    const r = await http<{
      ShipmentData?: {
        Shipment: {
          Status: { Status: string; StatusLocation?: string; StatusDateTime?: string; Instructions?: string };
          Scans?: { ScanDetail: { Scan: string; ScannedLocation?: string; ScanDateTime: string; Instructions?: string } }[];
        };
      }[];
    }>(`${dlBase(partner)}/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`, { headers: { Authorization: `Token ${c.token}` } });
    const s = r.ShipmentData?.[0]?.Shipment;
    if (!s) return null;
    const events = (s.Scans ?? []).map((x) => ({
      status: mapCourierStatus(`${x.ScanDetail.Scan} ${x.ScanDetail.Instructions ?? ""}`),
      location: x.ScanDetail.ScannedLocation,
      note: x.ScanDetail.Instructions || x.ScanDetail.Scan,
      occurredAt: new Date(x.ScanDetail.ScanDateTime),
    }));
    const status = mapCourierStatus(`${s.Status.Status} ${s.Status.Instructions ?? ""}`);
    return { status, events, ndrReason: status === "NDR" ? s.Status.Instructions : undefined };
  },
  async cancel(awb, partner) {
    const c = creds(partner);
    await http(`${dlBase(partner)}/api/p/edit`, {
      method: "POST",
      headers: { Authorization: `Token ${c.token}` },
      json: { waybill: awb, cancellation: "true" },
    });
  },
};

// ─────────────────────────────── India Post ──────────────────────────────────

/**
 * India Post Speed Post has no self-serve REST API; bookings are made at the
 * counter or via the DOP business portal. We record the article number manually
 * and link customers to the official tracker.
 */
const indiaPost: ShippingProvider = {
  code: "INDIA_POST",
  label: "India Post (Speed Post)",
  credentialFields: [{ key: "customerId", label: "DOP business customer ID (optional)" }],
  async createShipment(req) {
    if (!req.awb?.trim()) throw badRequest("Enter the Speed Post article number booked at the post office");
    const awb = req.awb.trim().toUpperCase();
    return {
      awb,
      courierName: "India Post",
      trackingUrl: tracking(req.partner, awb, "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx"),
      status: "IN_TRANSIT",
    };
  },
  async track() {
    return null;
  },
};

export const PROVIDERS: Record<string, ShippingProvider> = {
  MANUAL: manual,
  SHIPROCKET: shiprocket,
  DELHIVERY: delhivery,
  INDIA_POST: indiaPost,
};

export function getProvider(code: string) {
  const p = PROVIDERS[code];
  if (!p) throw badRequest(`Unknown shipping provider ${code}`);
  return p;
}
