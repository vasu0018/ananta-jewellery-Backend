import { Router } from "express";
import type { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryList, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { allowedTransitions, changeOrderStatus, createRefund, placeOrder, STATUS_LABEL } from "../../lib/orders";
import { buildQuote } from "../../lib/pricing";
import { invoicePdf, shippingLabelPdf } from "../../lib/pdf";
import { sendExport, type Column } from "../../lib/export";
import { num, round2, serialize } from "../../lib/utils";
import { addressSchema } from "../store";
import { phoneSchema } from "../../lib/phone";

const router = Router();
const read = requirePerm("orders.read");
const write = requirePerm("orders.write");

const ORDER_STATUSES = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURN_REQUESTED", "RETURNED"] as const;

function listWhere(req: import("express").Request): Prisma.OrderWhereInput {
  const q = queryString(req, "q");
  const statuses = queryList(req, "status");
  const from = queryString(req, "from");
  const to = queryString(req, "to");
  return {
    ...(statuses.length ? { status: { in: statuses as OrderStatus[] } } : {}),
    ...(queryString(req, "paymentStatus") ? { paymentStatus: queryString(req, "paymentStatus") as PaymentStatus } : {}),
    ...(queryString(req, "paymentMethod") ? { paymentMethod: queryString(req, "paymentMethod") as PaymentMethod } : {}),
    ...(queryString(req, "source") ? { source: queryString(req, "source") as never } : {}),
    ...(queryString(req, "customerId") ? { customerId: queryString(req, "customerId") } : {}),
    ...(from || to
      ? { placedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999+05:30`) } : {}) } }
      : {}),
    ...(q
      ? {
          OR: [
            { orderNumber: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { customerName: { contains: q, mode: "insensitive" } },
            { invoiceNumber: { contains: q, mode: "insensitive" } },
            { shipments: { some: { awb: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
}

type OrderRow = Prisma.OrderGetPayload<{ include: { _count: { select: { items: true } } } }>;
const EXPORT_COLUMNS: Column<OrderRow>[] = [
  { key: "orderNumber", label: "Order", width: 18 },
  { key: "placedAt", label: "Date", value: (o) => o.placedAt.toISOString().slice(0, 16).replace("T", " ") },
  { key: "customerName", label: "Customer", width: 22 },
  { key: "email", label: "Email", width: 26 },
  { key: "phone", label: "Phone" },
  { key: "status", label: "Status", value: (o) => STATUS_LABEL[o.status] },
  { key: "paymentStatus", label: "Payment" },
  { key: "paymentMethod", label: "Method" },
  { key: "items", label: "Items", value: (o) => o._count.items },
  { key: "subtotal", label: "Subtotal", value: (o) => num(o.subtotal) },
  { key: "discount", label: "Discount", value: (o) => num(o.discount) + num(o.loyaltyDiscount) },
  { key: "shippingFee", label: "Shipping", value: (o) => num(o.shippingFee) + num(o.codFee) },
  { key: "taxTotal", label: "GST", value: (o) => num(o.taxTotal) },
  { key: "total", label: "Total", value: (o) => num(o.total) },
  { key: "refundedAmount", label: "Refunded", value: (o) => num(o.refundedAmount) },
  { key: "city", label: "City", value: (o) => (o.shippingAddress as { city?: string })?.city ?? "" },
  { key: "state", label: "State", value: (o) => (o.shippingAddress as { state?: string })?.state ?? "" },
  { key: "invoiceNumber", label: "Invoice" },
];

router.get("/orders", read, async (req, res) => {
  const where = listWhere(req);
  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.order.findMany({ where, orderBy: { placedAt: "desc" }, include: { _count: { select: { items: true } } }, take: 10000 });
    await sendExport(res, format, "orders", rows, EXPORT_COLUMNS);
    return;
  }
  const { page, limit, skip, take } = pageArgs(req.query);
  const sort = queryString(req, "sort");
  const orderBy: Prisma.OrderOrderByWithRelationInput =
    sort === "total_desc" ? { total: "desc" } : sort === "total_asc" ? { total: "asc" } : sort === "oldest" ? { placedAt: "asc" } : { placedAt: "desc" };
  const [total, items, sum] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy,
      skip,
      take,
      include: {
        _count: { select: { items: true } },
        items: { take: 1, select: { image: true, name: true } },
        shipments: { orderBy: { createdAt: "desc" }, take: 1, select: { awb: true, courierName: true, status: true } },
      },
    }),
    prisma.order.aggregate({ where, _sum: { total: true } }),
  ]);
  res.json(
    serialize({
      items: items.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        placedAt: o.placedAt,
        customerName: o.customerName,
        email: o.email,
        phone: o.phone,
        customerId: o.customerId,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        source: o.source,
        total: o.total,
        itemCount: o._count.items,
        firstItem: o.items[0] ?? null,
        city: (o.shippingAddress as { city?: string })?.city,
        state: (o.shippingAddress as { state?: string })?.state,
        shipment: o.shipments[0] ?? null,
      })),
      meta: pageMeta(total, page, limit),
      totalValue: sum._sum.total ?? 0,
    }),
  );
});

router.get("/orders/status-counts", read, async (_req, res) => {
  const [byStatus, unpaid] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.order.count({ where: { paymentStatus: { in: ["PENDING", "FAILED"] }, status: { not: "CANCELLED" }, paymentMethod: { not: "COD" } } }),
  ]);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const g of byStatus) counts[g.status] = g._count._all;
  res.json({ counts, all: byStatus.reduce((s, g) => s + g._count._all, 0), unpaid });
});

const bulkStatus = z.object({ ids: z.array(z.string()).min(1).max(200), status: z.enum(ORDER_STATUSES), note: z.string().max(500).optional() });

router.post("/orders/bulk-status", write, async (req, res) => {
  const body = parse(bulkStatus, req.body);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of body.ids) {
    try {
      await changeOrderStatus(id, body.status, { note: body.note, adminId: req.admin!.sub, actorName: req.admin!.name, restock: true });
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await logActivity(req, "order.bulk_status", "Order", null, `${body.status} for ${body.ids.length} orders`);
  res.json({ results, updated: results.filter((r) => r.ok).length });
});

// ───────────────────────────── Manual orders ─────────────────────────────────

const manualAddress = addressSchema.omit({ type: true, isDefault: true });
const manualSchema = z.object({
  customerId: z.string().optional().nullable(),
  email: z.string().trim().toLowerCase().email(),
  phone: phoneSchema,
  customerName: z.string().trim().min(2).max(80),
  items: z.array(z.object({ variantId: z.string(), quantity: z.number().int().min(1).max(50) })).min(1).max(50),
  couponCode: z.string().trim().max(40).optional().nullable(),
  shippingRateId: z.string().optional().nullable(),
  paymentMethod: z.enum(["COD", "MANUAL", "UPI", "CARD", "NETBANKING"]).default("COD"),
  markPaid: z.boolean().default(false),
  giftWrap: z.boolean().optional(),
  giftMessage: z.string().max(300).optional().nullable(),
  shippingAddress: manualAddress,
  billingAddress: manualAddress.optional().nullable(),
  customerNote: z.string().max(500).optional().nullable(),
  internalNote: z.string().max(1000).optional().nullable(),
});

/** Live pricing while the manual order form is still being filled in, so nothing but items is required. */
const quoteSchema = z.object({
  items: manualSchema.shape.items,
  customerId: z.string().optional().nullable(),
  email: z.string().trim().toLowerCase().optional().nullable(),
  couponCode: z.string().trim().max(40).optional().nullable(),
  shippingRateId: z.string().optional().nullable(),
  paymentMethod: manualSchema.shape.paymentMethod,
  giftWrap: z.boolean().optional(),
  state: z.string().trim().max(80).optional().nullable(),
  pincode: z.string().trim().max(6).optional().nullable(),
});

router.post("/orders/quote", read, async (req, res) => {
  const body = parse(quoteSchema, req.body);
  res.json(
    await buildQuote({
      items: body.items,
      couponCode: body.couponCode,
      state: body.state || undefined,
      pincode: body.pincode && /^\d{6}$/.test(body.pincode) ? body.pincode : undefined,
      paymentMethod: body.paymentMethod === "COD" ? "COD" : "RAZORPAY",
      shippingRateId: body.shippingRateId,
      giftWrap: body.giftWrap,
      customerId: body.customerId ?? null,
      email: body.email,
    }),
  );
});

router.post("/orders", write, async (req, res) => {
  const body = parse(manualSchema, req.body);
  let customerId = body.customerId ?? null;
  if (!customerId) {
    const existing = await prisma.customer.findUnique({ where: { email: body.email } });
    if (existing) customerId = existing.id;
    else {
      const phoneTaken = await prisma.customer.findUnique({ where: { phone: body.phone } });
      const created = await prisma.customer.create({
        data: { name: body.customerName, email: body.email, phone: phoneTaken ? undefined : body.phone, tags: ["manual-order"] },
      });
      customerId = created.id;
    }
  }
  const order = await placeOrder({
    items: body.items,
    couponCode: body.couponCode,
    shippingRateId: body.shippingRateId,
    paymentMethod: body.paymentMethod as PaymentMethod,
    giftWrap: body.giftWrap,
    customerId,
    email: body.email,
    phone: body.phone,
    customerName: body.customerName,
    shippingAddress: body.shippingAddress,
    billingAddress: body.billingAddress,
    giftMessage: body.giftMessage,
    customerNote: body.customerNote,
    internalNote: body.internalNote,
    source: "ADMIN",
    adminId: req.admin!.sub,
    markPaid: body.paymentMethod !== "COD" && body.markPaid,
  });
  // Manual non-COD orders that are not yet paid still need confirming by staff.
  if (order.status === "PENDING" && body.paymentMethod !== "COD") {
    await prisma.orderEvent.create({ data: { orderId: order.id, title: "Awaiting payment", note: "Manual order created — mark as paid once payment is received", adminId: req.admin!.sub, isPublic: false } });
  }
  await logActivity(req, "order.create", "Order", order.id, `Manual order ${order.orderNumber}`);
  res.status(201).json({ id: order.id, orderNumber: order.orderNumber });
});

// ───────────────────────────── Order detail ──────────────────────────────────

const detailInclude = {
  items: true,
  events: { orderBy: { createdAt: "desc" }, include: { admin: { select: { name: true } } } },
  payments: { orderBy: { createdAt: "desc" } },
  refunds: { orderBy: { createdAt: "desc" } },
  shipments: {
    orderBy: { createdAt: "desc" },
    include: { partner: { select: { id: true, name: true, code: true } }, events: { orderBy: { occurredAt: "desc" } }, ndrCases: true },
  },
  customer: { select: { id: true, name: true, email: true, phone: true, loyaltyPoints: true, tags: true, isBlocked: true, createdAt: true, _count: { select: { orders: true } } } },
} satisfies Prisma.OrderInclude;

router.get("/orders/:id", read, async (req, res) => {
  const id = param(req, "id");
  const order = await prisma.order.findFirst({ where: { OR: [{ id }, { orderNumber: id }] }, include: detailInclude });
  if (!order) throw notFound("Order not found");
  let lifetimeValue = 0;
  if (order.customerId) {
    const agg = await prisma.order.aggregate({
      where: { customerId: order.customerId, status: { notIn: ["CANCELLED", "PENDING"] } },
      _sum: { total: true },
    });
    lifetimeValue = num(agg._sum.total);
  }
  res.json(
    serialize({
      ...order,
      statusLabel: STATUS_LABEL[order.status],
      allowedTransitions: allowedTransitions(order.status),
      refundable: round2(num(order.total) - num(order.refundedAmount)),
      customer: order.customer ? { ...order.customer, lifetimeValue, orderCount: order.customer._count.orders } : null,
    }),
  );
});

router.patch("/orders/:id", write, async (req, res) => {
  const body = parse(
    z.object({
      internalNote: z.string().max(2000).optional().nullable(),
      giftMessage: z.string().max(300).optional().nullable(),
      shippingAddress: manualAddress.optional(),
      phone: phoneSchema.optional(),
    }),
    req.body,
  );
  const id = param(req, "id");
  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw notFound("Order not found");
  if (body.shippingAddress && ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"].includes(existing.status)) {
    throw badRequest("Address cannot be changed after the order has shipped");
  }
  const order = await prisma.order.update({
    where: { id },
    data: {
      ...body,
      events: body.shippingAddress
        ? { create: { title: "Shipping address updated", adminId: req.admin!.sub, isPublic: false } }
        : undefined,
    },
  });
  await logActivity(req, "order.update", "Order", id, order.orderNumber);
  res.json(serialize(order));
});

router.patch("/orders/:id/status", write, async (req, res) => {
  const body = parse(
    z.object({
      status: z.enum(ORDER_STATUSES),
      note: z.string().max(500).optional(),
      reason: z.string().max(300).optional(),
      restock: z.boolean().default(true),
      force: z.boolean().default(false),
    }),
    req.body,
  );
  const id = param(req, "id");
  const order = await changeOrderStatus(id, body.status, {
    note: body.note,
    reason: body.reason,
    restock: body.restock,
    force: body.force && req.admin!.role === "ADMIN",
    adminId: req.admin!.sub,
    actorName: req.admin!.name,
  });
  await logActivity(req, "order.status", "Order", id, `→ ${STATUS_LABEL[body.status]}`, { note: body.note });
  res.json(serialize(order));
});

router.post("/orders/:id/notes", write, async (req, res) => {
  const body = parse(z.object({ note: z.string().trim().min(1).max(1000), isPublic: z.boolean().default(false) }), req.body);
  const event = await prisma.orderEvent.create({
    data: { orderId: param(req, "id"), title: body.isPublic ? "Message to customer" : "Internal note", note: body.note, isPublic: body.isPublic, adminId: req.admin!.sub },
    include: { admin: { select: { name: true } } },
  });
  res.status(201).json(event);
});

router.post("/orders/:id/mark-paid", write, async (req, res) => {
  const body = parse(z.object({ reference: z.string().max(120).optional(), method: z.string().max(40).default("Bank transfer") }), req.body);
  const id = param(req, "id");
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound("Order not found");
  if (order.paymentStatus === "PAID") throw badRequest("Order is already paid");
  if (order.status === "CANCELLED") throw badRequest("Order is cancelled");
  await prisma.$transaction(async (tx) => {
    const cod = await tx.payment.findFirst({ where: { orderId: id, provider: "COD", status: "CREATED" } });
    if (cod) await tx.payment.update({ where: { id: cod.id }, data: { status: "CAPTURED", capturedAt: new Date(), method: body.method, providerPaymentId: body.reference || undefined } });
    else {
      await tx.payment.create({
        data: { orderId: id, provider: "MANUAL", method: body.method, amount: order.total, status: "CAPTURED", capturedAt: new Date(), providerPaymentId: body.reference || undefined },
      });
    }
    await tx.order.update({
      where: { id },
      data: { paymentStatus: "PAID", events: { create: { title: "Payment received", note: [body.method, body.reference].filter(Boolean).join(" · "), adminId: req.admin!.sub } } },
    });
  });
  if (order.status === "PENDING") await changeOrderStatus(id, "CONFIRMED", { adminId: req.admin!.sub, actorName: req.admin!.name, note: "Confirmed after manual payment" });
  await logActivity(req, "order.mark_paid", "Order", id, order.orderNumber);
  res.json({ ok: true });
});

router.post("/orders/:id/refunds", requirePerm("refunds.write"), async (req, res) => {
  const body = parse(
    z.object({
      amount: z.coerce.number().positive(),
      reason: z.string().max(300).optional(),
      items: z.array(z.object({ orderItemId: z.string(), quantity: z.number().int().min(1) })).optional(),
      restock: z.boolean().default(false),
    }),
    req.body,
  );
  const id = param(req, "id");
  const refund = await createRefund({ orderId: id, ...body, adminId: req.admin!.sub, actorName: req.admin!.name });
  await logActivity(req, "order.refund", "Order", id, `Refund ₹${body.amount}`, { reason: body.reason });
  res.status(201).json(serialize(refund));
});

router.get("/orders/:id/invoice", read, async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: param(req, "id") }, include: { items: true } });
  if (!order) throw notFound("Order not found");
  if (!order.invoiceNumber) throw badRequest("Invoice is generated once the order is confirmed");
  const pdf = await invoicePdf(order);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="invoice-${order.orderNumber}.pdf"`);
  res.send(pdf);
});

router.get("/orders/:id/packing-slip", read, async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: param(req, "id") }, include: { items: true, shipments: { orderBy: { createdAt: "desc" }, take: 1 } } });
  if (!order) throw notFound("Order not found");
  const shipment = order.shipments[0];
  if (!shipment) throw badRequest("Create a shipment first");
  const pdf = await shippingLabelPdf(order, shipment);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="label-${order.orderNumber}.pdf"`);
  res.send(pdf);
});

export default router;
