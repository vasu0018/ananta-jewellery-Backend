import { Router, type Request, type Response } from "express";
import type { NdrStatus, Prisma, ShipmentStatus, ShippingPartner } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { registerCrud } from "../../lib/crud";
import { shippingLabelPdf } from "../../lib/pdf";
import { maskSecret } from "../../lib/settings";
import {
  applyShipmentStatus,
  createShipmentForOrder,
  getProvider,
  mapCourierStatus,
  PROVIDERS,
  syncActiveShipments,
  syncShipmentTracking,
} from "../../lib/shipping";
import { sendExport } from "../../lib/export";
import { serialize } from "../../lib/utils";

const router = Router();
const read = requirePerm("shipping.read");
const write = requirePerm("shipping.write");

const SHIPMENT_STATUSES = [
  "CREATED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "NDR", "RTO_INITIATED", "RTO_DELIVERED", "CANCELLED",
] as const;

// ─────────────────────────────── Shipments ───────────────────────────────────

router.get("/shipping/shipments", read, async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const q = queryString(req, "q");
  const status = queryString(req, "status");
  const where: Prisma.ShipmentWhereInput = {
    ...(status ? { status: status as ShipmentStatus } : {}),
    ...(queryString(req, "partnerId") ? { partnerId: queryString(req, "partnerId") } : {}),
    ...(q
      ? {
          OR: [
            { awb: { contains: q, mode: "insensitive" } },
            { order: { orderNumber: { contains: q, mode: "insensitive" } } },
            { order: { customerName: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const include = {
    partner: { select: { name: true, code: true } },
    order: { select: { id: true, orderNumber: true, customerName: true, phone: true, paymentMethod: true, total: true, shippingAddress: true, status: true } },
    ndrCases: { where: { status: { in: ["OPEN", "REATTEMPT"] as NdrStatus[] } }, select: { id: true } },
  } satisfies Prisma.ShipmentInclude;

  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.shipment.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 10000 });
    await sendExport(res, format, "shipments", rows, [
      { key: "awb", label: "AWB" },
      { key: "courierName", label: "Courier" },
      { key: "order", label: "Order", value: (r) => r.order.orderNumber },
      { key: "customer", label: "Customer", value: (r) => r.order.customerName },
      { key: "city", label: "City", value: (r) => (r.order.shippingAddress as { city?: string }).city },
      { key: "pincode", label: "Pincode", value: (r) => (r.order.shippingAddress as { pincode?: string }).pincode },
      { key: "status", label: "Status" },
      { key: "payment", label: "Payment", value: (r) => r.order.paymentMethod },
      { key: "createdAt", label: "Created", value: (r) => r.createdAt.toISOString().slice(0, 10) },
    ]);
    return;
  }

  const [total, items, counts] = await Promise.all([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.shipment.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const readyToShip = await prisma.order.count({ where: { status: "CONFIRMED", shipments: { none: { status: { notIn: ["CANCELLED"] } } } } });
  res.json(
    serialize({
      items: items.map((s) => ({ ...s, openNdr: s.ndrCases.length > 0 })),
      meta: pageMeta(total, page, limit),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      readyToShip,
    }),
  );
});

/** Confirmed orders waiting for a shipment (the "To ship" queue). */
router.get("/shipping/queue", read, async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: { in: ["CONFIRMED", "PACKED"] }, shipments: { none: { status: { notIn: ["CANCELLED", "RTO_DELIVERED"] } } } },
    orderBy: { placedAt: "asc" },
    take: 200,
    select: { id: true, orderNumber: true, customerName: true, phone: true, placedAt: true, total: true, paymentMethod: true, status: true, shippingAddress: true, _count: { select: { items: true } } },
  });
  res.json(serialize(orders));
});

router.get("/shipping/shipments/:id", read, async (req, res) => {
  const s = await prisma.shipment.findUnique({
    where: { id: param(req, "id") },
    include: { partner: true, order: { include: { items: true } }, events: { orderBy: { occurredAt: "desc" } }, ndrCases: { orderBy: { createdAt: "desc" } } },
  });
  if (!s) throw notFound("Shipment not found");
  res.json(serialize({ ...s, partner: s.partner ? { id: s.partner.id, name: s.partner.name, code: s.partner.code } : null }));
});

const createShipmentSchema = z.object({
  partnerId: z.string().optional(),
  awb: z.string().trim().max(60).optional(),
  courierName: z.string().trim().max(80).optional(),
  weightGrams: z.coerce.number().positive().optional(),
  length: z.coerce.number().positive().optional(),
  width: z.coerce.number().positive().optional(),
  height: z.coerce.number().positive().optional(),
});

router.post("/orders/:id/shipments", write, async (req, res) => {
  const body = parse(createShipmentSchema, req.body);
  const shipment = await createShipmentForOrder({ orderId: param(req, "id"), ...body, adminId: req.admin!.sub, actorName: req.admin!.name });
  await logActivity(req, "shipment.create", "Shipment", shipment.id, `AWB ${shipment.awb}`);
  res.status(201).json(serialize(shipment));
});

router.post("/shipping/bulk-create", write, async (req, res) => {
  const body = parse(createShipmentSchema.pick({ partnerId: true }).extend({ orderIds: z.array(z.string()).min(1).max(100) }), req.body);
  const results: { orderId: string; ok: boolean; awb?: string | null; error?: string }[] = [];
  for (const orderId of body.orderIds) {
    try {
      const s = await createShipmentForOrder({ orderId, partnerId: body.partnerId, adminId: req.admin!.sub, actorName: req.admin!.name });
      results.push({ orderId, ok: true, awb: s.awb });
    } catch (e) {
      results.push({ orderId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await logActivity(req, "shipment.bulk_create", "Shipment", null, `${results.filter((r) => r.ok).length}/${results.length} created`);
  res.json({ results });
});

router.get("/shipping/shipments/:id/label", read, async (req, res) => {
  const s = await prisma.shipment.findUnique({ where: { id: param(req, "id") }, include: { order: { include: { items: true } } } });
  if (!s) throw notFound("Shipment not found");
  if (s.labelUrl && queryString(req, "source") !== "local") {
    res.redirect(s.labelUrl);
    return;
  }
  const pdf = await shippingLabelPdf(s.order, s);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="label-${s.awb ?? s.id}.pdf"`);
  res.send(pdf);
});

router.post("/shipping/shipments/:id/sync", write, async (req, res) => {
  res.json(serialize(await syncShipmentTracking(param(req, "id"))));
});

router.post("/shipping/sync-all", write, async (_req, res) => {
  res.json({ synced: await syncActiveShipments() });
});

router.post("/shipping/shipments/:id/status", write, async (req, res) => {
  const body = parse(
    z.object({ status: z.enum(SHIPMENT_STATUSES), location: z.string().max(120).optional(), note: z.string().max(500).optional(), ndrReason: z.string().max(300).optional() }),
    req.body,
  );
  const id = param(req, "id");
  const updated = await applyShipmentStatus(id, body.status, { ...body, adminId: req.admin!.sub });
  await logActivity(req, "shipment.status", "Shipment", id, body.status);
  res.json(serialize(updated));
});

router.post("/shipping/shipments/:id/pickup", write, async (req, res) => {
  const s = await prisma.shipment.findUnique({ where: { id: param(req, "id") }, include: { partner: true } });
  if (!s || !s.partner) throw notFound("Shipment not found");
  const provider = getProvider(s.partner.code);
  if (provider.schedulePickup && s.providerShipmentId) await provider.schedulePickup(s.providerShipmentId, s.partner);
  await prisma.shipment.update({ where: { id: s.id }, data: { pickupScheduledAt: new Date() } });
  const updated = await applyShipmentStatus(s.id, "PICKUP_SCHEDULED", { note: "Pickup scheduled", adminId: req.admin!.sub });
  res.json(serialize(updated));
});

router.post("/shipping/shipments/:id/cancel", write, async (req, res) => {
  const s = await prisma.shipment.findUnique({ where: { id: param(req, "id") }, include: { partner: true } });
  if (!s) throw notFound("Shipment not found");
  if (["DELIVERED", "RTO_DELIVERED", "CANCELLED"].includes(s.status)) throw badRequest("This shipment can no longer be cancelled");
  if (s.partner && s.awb) await getProvider(s.partner.code).cancel?.(s.awb, s.partner);
  await prisma.shipment.update({ where: { id: s.id }, data: { status: "CANCELLED", events: { create: { status: "CANCELLED", note: "Cancelled by admin" } } } });
  await prisma.orderEvent.create({ data: { orderId: s.orderId, title: "Shipment cancelled", note: s.awb ? `AWB ${s.awb}` : undefined, adminId: req.admin!.sub, isPublic: false } });
  await logActivity(req, "shipment.cancel", "Shipment", s.id, s.awb ?? undefined);
  res.json({ ok: true });
});

// ─────────────────────────────────── NDR ─────────────────────────────────────

router.get("/shipping/ndr", read, async (req, res) => {
  const status = queryString(req, "status");
  const rows = await prisma.ndrCase.findMany({
    where: status ? { status: status as NdrStatus } : { status: { in: ["OPEN", "REATTEMPT"] } },
    orderBy: { updatedAt: "desc" },
    include: {
      shipment: {
        select: {
          id: true, awb: true, courierName: true, status: true,
          order: { select: { id: true, orderNumber: true, customerName: true, phone: true, paymentMethod: true, total: true, shippingAddress: true } },
        },
      },
    },
    take: 300,
  });
  res.json(serialize(rows));
});

router.patch("/shipping/ndr/:id", write, async (req, res) => {
  const body = parse(
    z.object({ status: z.enum(["OPEN", "REATTEMPT", "RTO", "RESOLVED"]), action: z.string().max(300).optional(), notes: z.string().max(1000).optional() }),
    req.body,
  );
  const ndr = await prisma.ndrCase.update({
    where: { id: param(req, "id") },
    data: { ...body, resolvedAt: body.status === "RESOLVED" || body.status === "RTO" ? new Date() : null },
  });
  if (body.status === "RTO") {
    await applyShipmentStatus(ndr.shipmentId, "RTO_INITIATED", { note: body.notes ?? "RTO initiated after NDR", adminId: req.admin!.sub });
  }
  if (body.status === "REATTEMPT") {
    await prisma.shipmentEvent.create({ data: { shipmentId: ndr.shipmentId, status: "NDR", note: `Re-attempt requested${body.action ? `: ${body.action}` : ""}` } });
  }
  await logActivity(req, "ndr.update", "NdrCase", ndr.id, body.status);
  res.json(ndr);
});

// ─────────────────────────────── Zones & rates ───────────────────────────────

const rateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  type: z.enum(["FLAT", "WEIGHT", "PRICE"]).default("FLAT"),
  minValue: z.coerce.number().min(0).nullable().optional(),
  maxValue: z.coerce.number().min(0).nullable().optional(),
  price: z.coerce.number().min(0),
  freeAbove: z.coerce.number().min(0).nullable().optional(),
  codAvailable: z.boolean().default(true),
  codFee: z.coerce.number().min(0).default(0),
  minDays: z.coerce.number().int().min(0).default(3),
  maxDays: z.coerce.number().int().min(0).default(7),
  isActive: z.boolean().default(true),
});

registerCrud(router, "/shipping/zones", {
  model: prisma.shippingZone,
  area: "shipping",
  entity: "ShippingZone",
  createSchema: z.object({
    name: z.string().trim().min(2).max(80),
    states: z.array(z.string()).default([]),
    pincodes: z.array(z.string().regex(/^\d{2,6}$/)).default([]),
    isActive: z.boolean().default(true),
    sortOrder: z.coerce.number().int().default(0),
  }),
  orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  include: { rates: { orderBy: { price: "asc" } } },
  searchFields: ["name"],
});

router.post("/shipping/zones/:id/rates", write, async (req, res) => {
  const body = parse(rateSchema, req.body);
  const rate = await prisma.shippingRate.create({ data: { ...body, zoneId: param(req, "id") } });
  await logActivity(req, "shipping_rate.create", "ShippingRate", rate.id, rate.name);
  res.status(201).json(serialize(rate));
});

router.patch("/shipping/rates/:id", write, async (req, res) => {
  const body = parse(rateSchema.partial(), req.body);
  const rate = await prisma.shippingRate.update({ where: { id: param(req, "id") }, data: body });
  await logActivity(req, "shipping_rate.update", "ShippingRate", rate.id, rate.name);
  res.json(serialize(rate));
});

router.delete("/shipping/rates/:id", write, async (req, res) => {
  await prisma.shippingRate.delete({ where: { id: param(req, "id") } });
  await logActivity(req, "shipping_rate.delete", "ShippingRate", param(req, "id"));
  res.json({ ok: true });
});

// ───────────────────────────────── Partners ──────────────────────────────────

function presentPartner(p: ShippingPartner) {
  const provider = PROVIDERS[p.code];
  const raw = (p.credentials ?? {}) as Record<string, string>;
  const fields = provider?.credentialFields ?? [];
  const credentials = Object.fromEntries(fields.map((f) => [f.key, f.secret ? maskSecret(raw[f.key]) : raw[f.key] ?? ""]));
  return {
    ...p,
    label: provider?.label ?? p.name,
    credentialFields: fields,
    credentials,
    webhookToken: raw.webhookToken ? maskSecret(raw.webhookToken) : "",
    configured: fields.every((f) => !!raw[f.key]),
    supportsTracking: ["SHIPROCKET", "DELHIVERY"].includes(p.code),
  };
}

router.get("/shipping/partners", read, async (_req, res) => {
  const partners = await prisma.shippingPartner.findMany({ orderBy: { name: "asc" } });
  const usage = await prisma.shipment.groupBy({ by: ["partnerId"], _count: { _all: true } });
  res.json(
    partners.map((p) => ({ ...presentPartner(p), shipmentCount: usage.find((u) => u.partnerId === p.id)?._count._all ?? 0 })),
  );
});

router.patch("/shipping/partners/:id", requirePerm("shipping.write"), async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().max(60).optional(),
      isActive: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      mode: z.enum(["TEST", "LIVE"]).optional(),
      trackingUrl: z.string().max(300).optional().nullable(),
      credentials: z.record(z.string(), z.string()).optional(),
      webhookToken: z.string().max(120).optional(),
    }),
    req.body,
  );
  const id = param(req, "id");
  const partner = await prisma.shippingPartner.findUnique({ where: { id } });
  if (!partner) throw notFound("Partner not found");
  const current = (partner.credentials ?? {}) as Record<string, string>;
  const merged = { ...current };
  for (const [k, v] of Object.entries(body.credentials ?? {})) {
    // Masked values coming back from the UI mean "unchanged".
    if (!v.includes("••••")) merged[k] = v;
  }
  if (body.webhookToken !== undefined && !body.webhookToken.includes("••••")) merged.webhookToken = body.webhookToken;
  if (body.isDefault) await prisma.shippingPartner.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
  const updated = await prisma.shippingPartner.update({
    where: { id },
    data: {
      name: body.name,
      isActive: body.isActive,
      isDefault: body.isDefault,
      mode: body.mode,
      trackingUrl: body.trackingUrl,
      credentials: merged,
    },
  });
  await logActivity(req, "shipping_partner.update", "ShippingPartner", id, updated.name);
  res.json(presentPartner(updated));
});

router.post("/shipping/partners/:id/test", write, async (req, res) => {
  const partner = await prisma.shippingPartner.findUnique({ where: { id: param(req, "id") } });
  if (!partner) throw notFound("Partner not found");
  const provider = getProvider(partner.code);
  if (!provider.testConnection) {
    res.json({ ok: true, message: `${provider.label} does not need an API connection.` });
    return;
  }
  try {
    res.json({ ok: true, message: await provider.testConnection(partner) });
  } catch (e) {
    res.json({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
  }
});

export default router;

/**
 * Public courier webhook: POST /api/v1/webhooks/shipping/:code?token=...
 * Accepts Shiprocket / Delhivery style payloads ({ awb, current_status, ... }).
 */
export async function shippingWebhook(req: Request, res: Response) {
  const code = param(req, "code").toUpperCase();
  const partner = await prisma.shippingPartner.findUnique({ where: { code } });
  if (!partner) throw notFound("Unknown partner");
  const expected = ((partner.credentials ?? {}) as Record<string, string>).webhookToken;
  const token = queryString(req, "token") ?? (req.headers["x-api-key"] as string | undefined);
  if (!expected || token !== expected) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pkg = (b.Shipment ?? b) as Record<string, unknown>;
  const awb = String(pkg.awb ?? pkg.AWB ?? pkg.awb_code ?? "").trim();
  const statusObj = pkg.Status as { Status?: string; StatusLocation?: string; Instructions?: string } | undefined;
  const text = String(pkg.current_status ?? pkg.shipment_status ?? statusObj?.Status ?? pkg.status ?? "");
  if (!awb || !text) {
    res.json({ ok: true, ignored: true });
    return;
  }
  const shipment = await prisma.shipment.findUnique({ where: { awb } });
  if (!shipment) {
    res.json({ ok: true, ignored: true });
    return;
  }
  const status = mapCourierStatus(text);
  await applyShipmentStatus(shipment.id, status, {
    location: String(pkg.current_location ?? statusObj?.StatusLocation ?? "") || undefined,
    note: text,
    ndrReason: status === "NDR" ? String(pkg.ndr_reason ?? statusObj?.Instructions ?? text) : undefined,
  });
  res.json({ ok: true });
}
