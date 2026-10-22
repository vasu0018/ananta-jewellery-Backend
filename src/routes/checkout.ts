import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { badRequest, notFound, parse, queryString, unauthorized } from "../lib/http";
import { optionalCustomer } from "../middleware/auth";
import { checkoutLimiter } from "../middleware/rateLimit";
import { buildQuote } from "../lib/pricing";
import { markOrderPaid, placeOrder, STATUS_LABEL } from "../lib/orders";
import { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature } from "../lib/razorpay";
import { getSetting } from "../lib/settings";
import { num, serialize } from "../lib/utils";
import { addressSchema } from "./store";
import { phoneSchema } from "../lib/phone";

const router = Router();

const quoteSchema = z.object({
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(10) })).max(50),
  couponCode: z.string().trim().max(40).optional().nullable(),
  state: z.string().max(80).optional().nullable(),
  pincode: z.string().max(10).optional().nullable(),
  paymentMethod: z.enum(["RAZORPAY", "COD"]).optional().nullable(),
  shippingRateId: z.string().optional().nullable(),
  giftWrap: z.boolean().optional(),
  loyaltyPoints: z.number().int().min(0).optional(),
  email: z.string().email().optional().nullable(),
});

router.post("/quote", optionalCustomer, async (req, res) => {
  const body = parse(quoteSchema, req.body);
  res.json(
    await buildQuote({
      ...body,
      customerId: req.customer?.sub ?? null,
      loyaltyPoints: req.customer ? body.loyaltyPoints : 0,
    }),
  );
});

router.get("/offers", async (_req, res) => {
  const now = new Date();
  const coupons = await prisma.coupon.findMany({
    where: {
      isActive: true,
      isPublic: true,
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    },
    orderBy: { createdAt: "desc" },
    select: { code: true, description: true, type: true, value: true, minOrderValue: true, maxDiscount: true, endsAt: true, firstOrderOnly: true },
  });
  res.json(serialize(coupons));
});

const placeSchema = quoteSchema.extend({
  paymentMethod: z.enum(["RAZORPAY", "COD"]),
  email: z.string().trim().toLowerCase().email(),
  phone: phoneSchema,
  shippingAddress: addressSchema.omit({ type: true, isDefault: true }),
  billingAddress: addressSchema.omit({ type: true, isDefault: true }).optional().nullable(),
  giftMessage: z.string().max(300).optional().nullable(),
  customerNote: z.string().max(500).optional().nullable(),
  saveAddress: z.boolean().optional(),
  acceptsMarketing: z.boolean().optional(),
});

/** Resolve the customer for an order: logged-in user, or create/link a guest record by email. */
async function resolveCustomer(req: Request, body: z.infer<typeof placeSchema>) {
  if (req.customer) return req.customer.sub;
  const checkout = await getSetting("checkout");
  if (!checkout.guestCheckout) throw unauthorized("Please sign in to place an order");
  const existing = await prisma.customer.findUnique({ where: { email: body.email } });
  if (existing) return existing.isBlocked ? null : existing.id;
  const phoneTaken = await prisma.customer.findUnique({ where: { phone: body.phone } });
  const created = await prisma.customer.create({
    data: {
      name: body.shippingAddress.name,
      email: body.email,
      phone: phoneTaken ? undefined : body.phone,
      acceptsMarketing: body.acceptsMarketing ?? true,
      tags: ["guest"],
    },
  });
  return created.id;
}

router.post("/orders", checkoutLimiter, optionalCustomer, async (req, res) => {
  const body = parse(placeSchema, req.body);
  const payments = await getSetting("payments");
  if (body.paymentMethod === "RAZORPAY" && !payments.razorpay.enabled) throw badRequest("Online payments are temporarily unavailable");

  const customerId = await resolveCustomer(req, body);
  if (customerId === null) throw unauthorized("This account has been suspended. Please contact support.");
  if (req.customer) {
    const c = await prisma.customer.findUnique({ where: { id: req.customer.sub }, select: { isBlocked: true } });
    if (c?.isBlocked) throw unauthorized("This account has been suspended. Please contact support.");
  }

  const order = await placeOrder({
    items: body.items,
    couponCode: body.couponCode,
    shippingRateId: body.shippingRateId,
    paymentMethod: body.paymentMethod,
    giftWrap: body.giftWrap,
    loyaltyPoints: req.customer ? body.loyaltyPoints : 0,
    customerId,
    email: body.email,
    phone: body.phone,
    customerName: body.shippingAddress.name,
    shippingAddress: body.shippingAddress,
    billingAddress: body.billingAddress,
    giftMessage: body.giftMessage,
    customerNote: body.customerNote,
    source: "WEB",
  });

  if (req.customer && body.saveAddress) {
    const dup = await prisma.address.findFirst({
      where: { customerId: req.customer.sub, line1: body.shippingAddress.line1, pincode: body.shippingAddress.pincode },
    });
    if (!dup) {
      const count = await prisma.address.count({ where: { customerId: req.customer.sub } });
      await prisma.address.create({ data: { ...body.shippingAddress, customerId: req.customer.sub, isDefault: count === 0 } });
    }
  }

  const summary = { id: order.id, orderNumber: order.orderNumber, total: num(order.total), status: order.status, paymentMethod: order.paymentMethod };
  if (body.paymentMethod === "COD") {
    res.status(201).json({ order: summary });
    return;
  }
  const rzp = await createRazorpayOrder(num(order.total), order.orderNumber, { orderNumber: order.orderNumber });
  await prisma.payment.create({
    data: { orderId: order.id, provider: "RAZORPAY", amount: order.total, status: "CREATED", providerOrderId: rzp.id },
  });
  const store = await getSetting("store");
  res.status(201).json({
    order: summary,
    razorpay: {
      keyId: rzp.keyId,
      orderId: rzp.id,
      amount: rzp.amount,
      currency: rzp.currency,
      mock: rzp.mock,
      name: store.name,
      description: `Order ${order.orderNumber}`,
      prefill: { name: body.shippingAddress.name, email: body.email, contact: body.phone },
    },
  });
});

/** Retry payment for an unpaid online order (new Razorpay order id). */
router.post("/orders/:orderNumber/pay", checkoutLimiter, optionalCustomer, async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email().optional() }), req.body ?? {});
  const order = await prisma.order.findUnique({ where: { orderNumber: String(req.params.orderNumber) } });
  if (!order) throw notFound("Order not found");
  const owns = (req.customer && order.customerId === req.customer.sub) || (email && email.toLowerCase() === order.email);
  if (!owns) throw unauthorized();
  if (order.paymentStatus === "PAID") throw badRequest("This order is already paid");
  if (order.status !== "PENDING") throw badRequest("This order can no longer be paid online");
  const rzp = await createRazorpayOrder(num(order.total), order.orderNumber, { orderNumber: order.orderNumber });
  await prisma.payment.create({ data: { orderId: order.id, provider: "RAZORPAY", amount: order.total, status: "CREATED", providerOrderId: rzp.id } });
  const store = await getSetting("store");
  res.json({
    order: { id: order.id, orderNumber: order.orderNumber, total: num(order.total) },
    razorpay: {
      keyId: rzp.keyId,
      orderId: rzp.id,
      amount: rzp.amount,
      currency: rzp.currency,
      mock: rzp.mock,
      name: store.name,
      description: `Order ${order.orderNumber}`,
      prefill: { name: order.customerName, email: order.email, contact: order.phone },
    },
  });
});

router.post("/razorpay/verify", checkoutLimiter, async (req, res) => {
  const body = parse(
    z.object({
      razorpay_order_id: z.string().min(1),
      razorpay_payment_id: z.string().min(1),
      razorpay_signature: z.string().min(1),
      method: z.string().optional(),
    }),
    req.body,
  );
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: body.razorpay_order_id }, include: { order: true } });
  if (!payment) throw notFound("Payment not found");
  const valid = await verifyPaymentSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature);
  if (!valid) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED", errorMessage: "Signature verification failed" } });
    throw badRequest("Payment verification failed. If money was debited it will be auto-refunded.");
  }
  await markOrderPaid(payment.orderId, {
    providerOrderId: body.razorpay_order_id,
    providerPaymentId: body.razorpay_payment_id,
    signature: body.razorpay_signature,
    method: body.method,
  });
  res.json({ ok: true, orderNumber: payment.order.orderNumber });
});

router.post("/razorpay/failed", async (req, res) => {
  const body = parse(
    z.object({ razorpay_order_id: z.string().min(1), code: z.string().optional(), description: z.string().optional() }),
    req.body,
  );
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: body.razorpay_order_id } });
  if (payment && payment.status === "CREATED") {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "FAILED", errorCode: body.code, errorMessage: body.description },
    });
    await prisma.order.update({
      where: { id: payment.orderId },
      data: { paymentStatus: "FAILED", events: { create: { title: "Payment failed", note: body.description ?? "Payment was not completed", isPublic: false } } },
    });
  }
  res.json({ ok: true });
});

/** Public order tracking (guest): order number + email or phone. */
router.get("/track", async (req, res) => {
  const orderNumber = queryString(req, "order")?.trim().toUpperCase();
  const contact = queryString(req, "contact")?.trim().toLowerCase();
  if (!orderNumber || !contact) throw badRequest("Order number and email/phone are required");
  const order = await prisma.order.findFirst({
    where: { orderNumber, OR: [{ email: contact }, { phone: contact }] },
    include: {
      items: { select: { name: true, image: true, quantity: true, variantTitle: true } },
      events: { where: { isPublic: true }, orderBy: { createdAt: "asc" }, select: { status: true, title: true, note: true, createdAt: true } },
      shipments: {
        orderBy: { createdAt: "desc" },
        select: { awb: true, courierName: true, trackingUrl: true, status: true, events: { orderBy: { occurredAt: "desc" } } },
      },
    },
  });
  if (!order) throw notFound("We couldn't find an order with those details");
  res.json(
    serialize({
      orderNumber: order.orderNumber,
      status: order.status,
      statusLabel: STATUS_LABEL[order.status],
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      total: order.total,
      placedAt: order.placedAt,
      items: order.items,
      events: order.events,
      shipments: order.shipments,
    }),
  );
});

export default router;

/** Razorpay webhook handler — mounted with a raw body parser in app.ts. */
export async function razorpayWebhook(req: Request, res: import("express").Response) {
  const raw = req.body as Buffer;
  const ok = await verifyWebhookSignature(raw, req.headers["x-razorpay-signature"] as string | undefined);
  if (!ok) {
    res.status(400).json({ message: "Invalid signature" });
    return;
  }
  const event = JSON.parse(raw.toString("utf8")) as {
    event: string;
    payload: {
      payment?: { entity: { id: string; order_id: string; method?: string; error_description?: string; error_code?: string } };
      refund?: { entity: { id: string; status: string } };
    };
  };
  const p = event.payload.payment?.entity;
  if ((event.event === "payment.captured" || event.event === "order.paid") && p?.order_id) {
    const payment = await prisma.payment.findUnique({ where: { providerOrderId: p.order_id } });
    if (payment) await markOrderPaid(payment.orderId, { providerOrderId: p.order_id, providerPaymentId: p.id, method: p.method, raw: event });
  } else if (event.event === "payment.failed" && p?.order_id) {
    await prisma.payment.updateMany({
      where: { providerOrderId: p.order_id, status: "CREATED" },
      data: { status: "FAILED", errorCode: p.error_code, errorMessage: p.error_description },
    });
  } else if (event.event.startsWith("refund.") && event.payload.refund) {
    const r = event.payload.refund.entity;
    await prisma.refund.updateMany({
      where: { providerRefundId: r.id },
      data: { status: r.status === "processed" ? "PROCESSED" : r.status === "failed" ? "FAILED" : "PENDING" },
    });
  }
  res.json({ ok: true });
}
