import type { OrderStatus, ShipmentStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { badRequest, notFound } from "../http";
import { getSetting } from "../settings";
import { changeOrderStatus } from "../orders";
import { notifyAdmins } from "../audit";
import { getProvider } from "./providers";
import type { TrackingEvent } from "./types";

export * from "./types";
export { PROVIDERS, getProvider } from "./providers";

/** Create a shipment for an order with the chosen partner and move the order to PACKED. */
export async function createShipmentForOrder(input: {
  orderId: string;
  partnerId?: string;
  awb?: string;
  courierName?: string;
  weightGrams?: number;
  length?: number;
  width?: number;
  height?: number;
  adminId?: string;
  actorName?: string;
}) {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { items: true, shipments: true } });
  if (!order) throw notFound("Order not found");
  if (["CANCELLED", "RETURNED", "PENDING"].includes(order.status)) {
    throw badRequest(order.status === "PENDING" ? "Confirm the order before shipping" : "Order can no longer be shipped");
  }
  const active = order.shipments.find((s) => !["CANCELLED", "RTO_DELIVERED"].includes(s.status));
  if (active) throw badRequest(`Shipment ${active.awb ?? ""} already exists for this order`);

  const cfg = await getSetting("shipping");
  const partner = input.partnerId
    ? await prisma.shippingPartner.findUnique({ where: { id: input.partnerId } })
    : (await prisma.shippingPartner.findFirst({ where: { isDefault: true, isActive: true } })) ??
      (await prisma.shippingPartner.findUnique({ where: { code: cfg.defaultPartner } }));
  if (!partner) throw badRequest("No shipping partner configured");
  if (!partner.isActive) throw badRequest(`${partner.name} is disabled`);

  const pkg = {
    weightGrams: input.weightGrams ?? cfg.defaultWeightGrams,
    length: input.length ?? cfg.packageLength,
    width: input.width ?? cfg.packageWidth,
    height: input.height ?? cfg.packageHeight,
  };
  const result = await getProvider(partner.code).createShipment({
    order,
    partner,
    pkg,
    awb: input.awb,
    courierName: input.courierName,
  });

  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      partnerId: partner.id,
      awb: result.awb,
      courierName: result.courierName,
      providerShipmentId: result.providerShipmentId,
      trackingUrl: result.trackingUrl,
      labelUrl: result.labelUrl,
      status: result.status ?? "CREATED",
      weight: pkg.weightGrams,
      length: pkg.length,
      width: pkg.width,
      height: pkg.height,
      events: { create: { status: result.status ?? "CREATED", note: `AWB ${result.awb} generated with ${result.courierName}` } },
    },
  });
  await prisma.orderEvent.create({
    data: { orderId: order.id, title: "Shipment created", note: `${result.courierName} · AWB ${result.awb}`, adminId: input.adminId },
  });
  if (order.status === "CONFIRMED") {
    await changeOrderStatus(order.id, "PACKED", { adminId: input.adminId, actorName: input.actorName, note: "Packed for dispatch" });
  }
  return shipment;
}

const SHIPMENT_TO_ORDER: Partial<Record<ShipmentStatus, OrderStatus>> = {
  PICKED_UP: "SHIPPED",
  IN_TRANSIT: "SHIPPED",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  RTO_DELIVERED: "RETURNED",
};

/**
 * Apply a shipment status (from courier sync, webhook or manual update):
 * stores the event, opens NDR cases, and advances the order status.
 */
export async function applyShipmentStatus(
  shipmentId: string,
  status: ShipmentStatus,
  extra: { location?: string; note?: string; occurredAt?: Date; events?: TrackingEvent[]; ndrReason?: string; adminId?: string } = {},
) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, include: { events: true, order: true } });
  if (!shipment) throw notFound("Shipment not found");

  const incoming = extra.events?.length
    ? extra.events
    : [{ status, location: extra.location, note: extra.note, occurredAt: extra.occurredAt ?? new Date() }];
  const seen = new Set(shipment.events.map((e) => `${e.status}|${e.occurredAt.toISOString()}|${e.note ?? ""}`));
  const fresh = incoming.filter((e) => !seen.has(`${e.status}|${e.occurredAt.toISOString()}|${e.note ?? ""}`));
  if (fresh.length) {
    await prisma.shipmentEvent.createMany({
      data: fresh.map((e) => ({ shipmentId, status: e.status, location: e.location, note: e.note, occurredAt: e.occurredAt })),
    });
  }

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      status,
      shippedAt: ["PICKED_UP", "IN_TRANSIT"].includes(status) ? shipment.shippedAt ?? new Date() : undefined,
      deliveredAt: status === "DELIVERED" ? new Date() : undefined,
    },
  });

  if (status === "NDR") {
    const open = await prisma.ndrCase.findFirst({ where: { shipmentId, status: { in: ["OPEN", "REATTEMPT"] } } });
    if (open) await prisma.ndrCase.update({ where: { id: open.id }, data: { attempts: { increment: 1 }, reason: extra.ndrReason ?? open.reason, status: "OPEN" } });
    else {
      await prisma.ndrCase.create({ data: { shipmentId, reason: extra.ndrReason ?? extra.note ?? "Delivery attempt failed" } });
      void notifyAdmins({
        type: "NDR",
        title: `NDR on ${shipment.order.orderNumber}`,
        body: extra.ndrReason ?? "Delivery attempt failed — action needed",
        link: "/dashboard/shipping/ndr",
      });
    }
  }

  const target = SHIPMENT_TO_ORDER[status];
  if (target && shipment.order.status !== target) {
    const order = shipment.order;
    // Walk forward through intermediate states so timestamps/emails fire correctly.
    const path: OrderStatus[] = [];
    if (target === "SHIPPED" && ["CONFIRMED", "PACKED"].includes(order.status)) path.push("SHIPPED");
    if (target === "OUT_FOR_DELIVERY") {
      if (["CONFIRMED", "PACKED"].includes(order.status)) path.push("SHIPPED");
      if (order.status !== "OUT_FOR_DELIVERY") path.push("OUT_FOR_DELIVERY");
    }
    if (target === "DELIVERED") {
      if (["CONFIRMED", "PACKED"].includes(order.status)) path.push("SHIPPED");
      path.push("DELIVERED");
    }
    if (target === "RETURNED") path.push("RETURNED");
    for (const s of path) {
      await changeOrderStatus(order.id, s, { adminId: extra.adminId, note: extra.note ?? `Courier update: ${status.replace(/_/g, " ").toLowerCase()}` }).catch(
        (e) => console.warn("[shipping] order status update skipped", e.message),
      );
    }
  }
  return prisma.shipment.findUnique({ where: { id: shipmentId }, include: { events: { orderBy: { occurredAt: "desc" } }, ndrCases: true } });
}

/** Pull latest tracking from the courier API. */
export async function syncShipmentTracking(shipmentId: string) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, include: { partner: true } });
  if (!shipment) throw notFound("Shipment not found");
  if (!shipment.awb || !shipment.partner) throw badRequest("Shipment has no AWB / partner");
  const result = await getProvider(shipment.partner.code).track(shipment.awb, shipment.partner);
  if (!result) return { updated: false, shipment, message: "This partner does not support automatic tracking. Update the status manually." };
  const updated = await applyShipmentStatus(shipmentId, result.status, { events: result.events, ndrReason: result.ndrReason });
  return { updated: true, shipment: updated };
}

/** Background job: refresh all in-flight shipments with API-enabled partners. */
export async function syncActiveShipments() {
  const active = await prisma.shipment.findMany({
    where: {
      status: { in: ["CREATED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "NDR"] },
      partner: { code: { in: ["SHIPROCKET", "DELHIVERY"] }, isActive: true },
    },
    select: { id: true },
    take: 100,
  });
  for (const s of active) await syncShipmentTracking(s.id).catch(() => undefined);
  return active.length;
}
