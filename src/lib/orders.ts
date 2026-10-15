import type { Order, OrderItem, OrderSource, OrderStatus, PaymentMethod, Prisma } from "@prisma/client";
import { prisma, type Tx } from "./prisma";
import { buildQuote, type QuoteInput } from "./pricing";
import { deductForOrder, restockItems } from "./inventory";
import { badRequest, conflict, notFound } from "./http";
import { getSetting } from "./settings";
import { sendTemplate } from "./mailer";
import { sendCustomerMessages, type MessageEvent } from "./messaging";
import { notifyAdmins } from "./audit";
import { refundRazorpayPayment } from "./razorpay";
import { formatInr, num, randomDigits, round2 } from "./utils";
import { env } from "../config/env";

export type AddressInput = {
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
  country?: string;
};

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "Pending payment",
  CONFIRMED: "Confirmed",
  PACKED: "Packed",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  RETURN_REQUESTED: "Return requested",
  RETURNED: "Returned",
};

const FLOW: OrderStatus[] = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

/** Which status changes are allowed from the current status. */
export function allowedTransitions(from: OrderStatus): OrderStatus[] {
  const idx = FLOW.indexOf(from);
  const next: OrderStatus[] = idx >= 0 ? FLOW.slice(idx + 1) : [];
  if (["PENDING", "CONFIRMED", "PACKED"].includes(from)) next.push("CANCELLED");
  if (from === "DELIVERED") next.push("RETURN_REQUESTED", "RETURNED");
  if (["SHIPPED", "OUT_FOR_DELIVERY"].includes(from)) next.push("RETURNED");
  if (from === "RETURN_REQUESTED") return ["RETURNED", "DELIVERED"];
  return next;
}

async function generateOrderNumber(db: Tx) {
  const d = new Date();
  const prefix = `AJ${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  for (let i = 0; i < 6; i++) {
    const candidate = `${prefix}${randomDigits(4)}`;
    const exists = await db.order.findUnique({ where: { orderNumber: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${prefix}${randomDigits(7)}`;
}

/** Financial-year based invoice number, e.g. AJ/INV/2026-27/000042 (Postgres sequence). */
async function nextInvoiceNumber(db: Tx) {
  const tax = await getSetting("tax");
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT nextval('invoice_seq') AS n`);
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${fyStart}-${String(fyStart + 1).slice(2)}`;
  return `${tax.invoicePrefix}/${fy}/${String(rows[0].n).padStart(6, "0")}`;
}

export async function ensureSequences() {
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1`);
}

function orderEmailVars(order: Order & { items?: OrderItem[] }) {
  const addr = order.shippingAddress as AddressInput;
  return {
    customerName: order.customerName,
    orderNumber: order.orderNumber,
    orderTotal: formatInr(num(order.total)),
    paymentMethod: order.paymentMethod === "COD" ? "Cash on Delivery" : "Prepaid",
    orderUrl: `${env.STOREFRONT_URL}/account/orders/${order.orderNumber}`,
    trackUrl: `${env.STOREFRONT_URL}/track-order?order=${order.orderNumber}`,
    shippingAddress: [addr.line1, addr.city, addr.state, addr.pincode].filter(Boolean).join(", "),
    itemsHtml: (order.items ?? [])
      .map(
        (i) =>
          `<tr><td style="padding:6px 0">${i.name}${i.variantTitle ? ` · ${i.variantTitle}` : ""} × ${i.quantity}</td><td align="right">${formatInr(num(i.total))}</td></tr>`,
      )
      .join(""),
  };
}

export type PlaceOrderInput = QuoteInput & {
  paymentMethod: PaymentMethod;
  email: string;
  phone: string;
  customerName: string;
  shippingAddress: AddressInput;
  billingAddress?: AddressInput | null;
  giftMessage?: string | null;
  customerNote?: string | null;
  internalNote?: string | null;
  source?: OrderSource;
  adminId?: string;
  /** Admin manual orders can be created as already paid (bank transfer etc). */
  markPaid?: boolean;
};

/**
 * Creates an order atomically: re-prices the bag, validates stock/coupon/COD,
 * deducts inventory, records coupon + loyalty usage and the initial timeline.
 */
export async function placeOrder(input: PlaceOrderInput) {
  const checkout = await getSetting("checkout");
  const loyaltyCfg = await getSetting("loyalty");

  const order = await prisma.$transaction(
    async (tx) => {
      const quote = await buildQuote(
        { ...input, state: input.shippingAddress.state, pincode: input.shippingAddress.pincode },
        tx,
      );
      if (!quote.lines.length) throw badRequest("Your bag is empty");
      const short = quote.lines.find((l) => l.available < l.quantity);
      if (short) throw conflict(short.available ? `Only ${short.available} left of ${short.name}` : `${short.name} is out of stock`);
      if (input.couponCode && quote.couponError) throw badRequest(quote.couponError);
      if (input.paymentMethod === "COD" && !quote.codAvailable) throw badRequest("Cash on Delivery is not available for this order");
      if (checkout.minOrderValue && quote.subtotal < checkout.minOrderValue) {
        throw badRequest(`Minimum order value is ${formatInr(checkout.minOrderValue)}`);
      }
      if (quote.lines.length && !quote.shippingRateId && input.source !== "ADMIN") {
        throw badRequest("We don't deliver to this pincode yet");
      }

      const isCod = input.paymentMethod === "COD";
      const confirmedNow = isCod || !!input.markPaid;
      const orderNumber = await generateOrderNumber(tx);
      const loyaltyEarned = loyaltyCfg.enabled && input.customerId
        ? Math.floor((quote.total / 100) * loyaltyCfg.earnPer100)
        : 0;

      const reduction = quote.discount + quote.loyalty.value;
      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: input.customerId ?? undefined,
          email: input.email.toLowerCase(),
          phone: input.phone,
          customerName: input.customerName,
          status: confirmedNow ? "CONFIRMED" : "PENDING",
          paymentStatus: input.markPaid ? "PAID" : "PENDING",
          paymentMethod: input.paymentMethod,
          source: input.source ?? "WEB",
          subtotal: quote.subtotal,
          discount: quote.discount,
          loyaltyDiscount: quote.loyalty.value,
          loyaltyRedeemed: quote.loyalty.applied,
          loyaltyEarned,
          shippingFee: quote.shippingFee,
          codFee: quote.codFee,
          giftWrapFee: quote.giftWrapFee,
          taxTotal: quote.taxTotal,
          total: quote.total,
          couponCode: quote.couponCode,
          shippingAddress: { ...input.shippingAddress, country: input.shippingAddress.country ?? "India" },
          billingAddress: (input.billingAddress ?? undefined) as Prisma.InputJsonValue | undefined,
          shippingRateId: quote.shippingRateId,
          shippingMethod: quote.shippingMethod,
          giftWrap: !!input.giftWrap,
          giftMessage: input.giftMessage,
          customerNote: input.customerNote,
          internalNote: input.internalNote,
          confirmedAt: confirmedNow ? new Date() : undefined,
          invoiceNumber: confirmedNow ? await nextInvoiceNumber(tx) : undefined,
          items: {
            create: quote.lines.map((l) => {
              const share = quote.subtotal ? (l.lineTotal / quote.subtotal) * reduction : 0;
              const net = l.lineTotal - share;
              return {
                productId: l.productId,
                variantId: l.variantId,
                name: l.name,
                sku: l.sku,
                variantTitle: l.variantTitle,
                image: l.image,
                unitPrice: l.unitPrice,
                quantity: l.quantity,
                discount: round2(share),
                taxRate: l.taxRate,
                taxAmount: round2(net - net / (1 + l.taxRate / 100)),
                total: l.lineTotal,
              };
            }),
          },
          events: {
            create: [
              {
                status: "PENDING",
                title: input.source === "ADMIN" ? "Order created by admin" : "Order placed",
                note: isCod ? "Cash on Delivery" : input.markPaid ? "Marked as paid" : "Awaiting online payment",
                adminId: input.adminId,
              },
              ...(confirmedNow ? [{ status: "CONFIRMED" as OrderStatus, title: "Order confirmed", adminId: input.adminId }] : []),
            ],
          },
          payments: {
            create: isCod
              ? { provider: "COD", method: "cod", amount: quote.total, status: "CREATED" }
              : input.markPaid
                ? { provider: "MANUAL", method: "manual", amount: quote.total, status: "CAPTURED", capturedAt: new Date() }
                : undefined,
          },
        },
        include: { items: true },
      });

      await deductForOrder(tx, created.items, created.id);

      if (quote.couponCode) {
        const coupon = await tx.coupon.update({ where: { code: quote.couponCode }, data: { usedCount: { increment: 1 } } });
        await tx.couponRedemption.create({
          data: { couponId: coupon.id, customerId: input.customerId ?? undefined, orderId: created.id, discount: quote.couponDiscount },
        });
      }
      if (quote.loyalty.applied && input.customerId) {
        await tx.customer.update({ where: { id: input.customerId }, data: { loyaltyPoints: { decrement: quote.loyalty.applied } } });
        await tx.loyaltyTransaction.create({
          data: { customerId: input.customerId, type: "REDEEM", points: -quote.loyalty.applied, orderId: created.id, note: `Redeemed on ${orderNumber}` },
        });
      }
      if (confirmedNow) await onConfirmed(tx, created);
      if (input.customerId && input.source !== "ADMIN") {
        await tx.cartItem.deleteMany({ where: { cart: { customerId: input.customerId } } });
      }
      return created;
    },
    { timeout: 20_000 },
  );

  if (order.status === "CONFIRMED") void afterConfirmedNotifications(order);
  return order;
}

/** Side effects when an order becomes confirmed (inside the transaction). */
async function onConfirmed(tx: Tx, order: Order & { items: OrderItem[] }) {
  for (const item of order.items) {
    if (item.productId) {
      await tx.product.update({ where: { id: item.productId }, data: { soldCount: { increment: item.quantity } } });
    }
  }
}

async function afterConfirmedNotifications(order: Order & { items: OrderItem[] }) {
  const notif = await getSetting("notifications");
  if (notif.email.enabled && notif.email.events.orderPlaced) {
    await sendTemplate("ORDER_CONFIRMATION", order.email, orderEmailVars(order));
  }
  await sendCustomerMessages("ORDER_CONFIRMATION", order.phone, orderEmailVars(order));
  await notifyAdmins({
    type: "ORDER_PLACED",
    title: `New order ${order.orderNumber}`,
    body: `${order.customerName} · ${formatInr(num(order.total))} · ${order.paymentMethod}`,
    link: `/dashboard/orders/${order.id}`,
  });
}

/** Mark an online payment as captured and confirm the order. Idempotent. */
export async function markOrderPaid(
  orderId: string,
  payment: { providerOrderId: string; providerPaymentId: string; signature?: string; method?: string; raw?: unknown },
) {
  const updated = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw notFound("Order not found");
    if (order.paymentStatus === "PAID") return null;

    await tx.payment.upsert({
      where: { providerOrderId: payment.providerOrderId },
      create: {
        orderId,
        provider: "RAZORPAY",
        method: payment.method,
        amount: order.total,
        status: "CAPTURED",
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        signature: payment.signature,
        raw: payment.raw as Prisma.InputJsonValue | undefined,
        capturedAt: new Date(),
      },
      update: {
        status: "CAPTURED",
        method: payment.method,
        providerPaymentId: payment.providerPaymentId,
        signature: payment.signature,
        raw: payment.raw as Prisma.InputJsonValue | undefined,
        capturedAt: new Date(),
      },
    });

    const wasPending = order.status === "PENDING";
    const next = await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: "PAID",
        status: wasPending ? "CONFIRMED" : order.status,
        confirmedAt: order.confirmedAt ?? new Date(),
        invoiceNumber: order.invoiceNumber ?? (await nextInvoiceNumber(tx)),
        paymentMethod: mapMethod(payment.method) ?? order.paymentMethod,
        events: {
          create: [
            { title: "Payment received", note: `Razorpay ${payment.providerPaymentId}`, isPublic: true },
            ...(wasPending ? [{ status: "CONFIRMED" as OrderStatus, title: "Order confirmed" }] : []),
          ],
        },
      },
      include: { items: true },
    });
    if (wasPending) await onConfirmed(tx, next);
    return next;
  });
  if (updated) void afterConfirmedNotifications(updated);
  return updated;
}

function mapMethod(method?: string): PaymentMethod | undefined {
  switch (method) {
    case "upi":
      return "UPI";
    case "card":
      return "CARD";
    case "netbanking":
      return "NETBANKING";
    case "wallet":
      return "WALLET";
    default:
      return method ? "RAZORPAY" : undefined;
  }
}

/**
 * Change order status with validation and side effects:
 * stock release on cancel/return, COD capture + loyalty on delivery, customer emails.
 */
export async function changeOrderStatus(
  orderId: string,
  status: OrderStatus,
  opts: { note?: string; adminId?: string; actorName?: string; restock?: boolean; force?: boolean; reason?: string } = {},
) {
  const loyaltyCfg = await getSetting("loyalty");
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw notFound("Order not found");
    if (order.status === status) return order;
    if (!opts.force && !allowedTransitions(order.status).includes(status)) {
      throw badRequest(`Cannot move order from ${STATUS_LABEL[order.status]} to ${STATUS_LABEL[status]}`);
    }

    const data: Prisma.OrderUpdateInput = { status };
    const now = new Date();
    if (status === "CONFIRMED") {
      data.confirmedAt = now;
      if (!order.invoiceNumber) data.invoiceNumber = await nextInvoiceNumber(tx);
    }
    if (status === "SHIPPED") data.shippedAt = order.shippedAt ?? now;
    if (status === "DELIVERED") {
      data.deliveredAt = now;
      if (order.paymentMethod === "COD" && order.paymentStatus !== "PAID") {
        data.paymentStatus = "PAID";
        await tx.payment.updateMany({ where: { orderId, provider: "COD" }, data: { status: "CAPTURED", capturedAt: now } });
      }
      if (order.customerId && order.loyaltyEarned > 0 && loyaltyCfg.enabled) {
        const already = await tx.loyaltyTransaction.findFirst({ where: { orderId, type: "EARN" } });
        if (!already) {
          await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: order.loyaltyEarned } } });
          await tx.loyaltyTransaction.create({
            data: { customerId: order.customerId, type: "EARN", points: order.loyaltyEarned, orderId, note: `Earned on ${order.orderNumber}` },
          });
        }
      }
    }
    if (status === "CANCELLED") {
      data.cancelledAt = now;
      data.cancelReason = opts.reason ?? opts.note;
      await restockItems(tx, order.items, "CANCELLATION", orderId, opts.actorName);
      if (order.paymentMethod === "COD" || order.paymentStatus !== "PAID") {
        await tx.payment.updateMany({ where: { orderId, status: "CREATED" }, data: { status: "FAILED", errorMessage: "Order cancelled" } });
      }
      if (order.customerId && order.loyaltyRedeemed > 0) {
        await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: order.loyaltyRedeemed } } });
        await tx.loyaltyTransaction.create({
          data: { customerId: order.customerId, type: "ADJUST", points: order.loyaltyRedeemed, orderId, note: `Refunded points for cancelled ${order.orderNumber}` },
        });
      }
      if (order.couponCode) {
        await tx.coupon.updateMany({ where: { code: order.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
      }
      if (order.status !== "PENDING") {
        for (const item of order.items) {
          if (item.productId) await tx.product.update({ where: { id: item.productId }, data: { soldCount: { decrement: item.quantity } } });
        }
      }
    }
    if (status === "RETURNED") {
      if (opts.restock !== false) await restockItems(tx, order.items, "RETURN", orderId, opts.actorName);
      const earned = await tx.loyaltyTransaction.findFirst({ where: { orderId, type: "EARN" } });
      if (earned && order.customerId) {
        await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { decrement: earned.points } } });
        await tx.loyaltyTransaction.create({
          data: { customerId: order.customerId, type: "ADJUST", points: -earned.points, orderId, note: `Reversed for returned ${order.orderNumber}` },
        });
      }
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        ...data,
        events: {
          create: { status, title: STATUS_LABEL[status], note: opts.note, adminId: opts.adminId },
        },
      },
      include: { items: true, shipments: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (status === "CONFIRMED" && order.status === "PENDING") await onConfirmed(tx, updated);
    return updated;
  });

  void statusEmail(result, status);
  return result;
}

async function statusEmail(order: Order & { items: OrderItem[]; shipments?: { awb: string | null; courierName: string | null; trackingUrl: string | null }[] }, status: OrderStatus) {
  const notif = await getSetting("notifications");
  const vars = {
    ...orderEmailVars(order),
    awb: order.shipments?.[0]?.awb ?? "",
    courierName: order.shipments?.[0]?.courierName ?? "our courier partner",
    trackingUrl: order.shipments?.[0]?.trackingUrl ?? `${env.STOREFRONT_URL}/track-order?order=${order.orderNumber}`,
  };
  const events: Partial<Record<OrderStatus, { key: MessageEvent; on: boolean }>> = {
    SHIPPED: { key: "ORDER_SHIPPED", on: notif.email.events.orderShipped },
    DELIVERED: { key: "ORDER_DELIVERED", on: notif.email.events.orderDelivered },
    CANCELLED: { key: "ORDER_CANCELLED", on: notif.email.events.orderCancelled },
    CONFIRMED: { key: "ORDER_CONFIRMATION", on: notif.email.events.orderPlaced },
  };
  const event = events[status];
  if (!event) return;
  if (notif.email.enabled && event.on) await sendTemplate(event.key, order.email, vars);
  await sendCustomerMessages(event.key, order.phone, vars);
}

/**
 * Full or partial refund. Online payments are refunded through Razorpay,
 * COD/manual refunds are recorded as processed (bank transfer done offline).
 */
export async function createRefund(input: {
  orderId: string;
  amount: number;
  reason?: string;
  items?: { orderItemId: string; quantity: number }[];
  restock?: boolean;
  adminId?: string;
  actorName?: string;
}) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { payments: true, items: true },
  });
  if (!order) throw notFound("Order not found");
  const paid = order.paymentStatus === "PAID" || order.paymentStatus === "PARTIALLY_REFUNDED";
  if (!paid) throw badRequest("Only paid orders can be refunded");
  const refundable = round2(num(order.total) - num(order.refundedAmount));
  if (input.amount <= 0 || input.amount > refundable) throw badRequest(`Refund amount must be between ₹1 and ${formatInr(refundable)}`);

  const captured = order.payments.find((p) => p.status === "CAPTURED" || p.status === "REFUNDED");
  let providerRefundId: string | undefined;
  if (captured?.provider === "RAZORPAY" && captured.providerPaymentId) {
    const r = await refundRazorpayPayment(captured.providerPaymentId, input.amount, { order: order.orderNumber });
    providerRefundId = r.id;
  }

  const refund = await prisma.$transaction(async (tx) => {
    const totalRefunded = round2(num(order.refundedAmount) + input.amount);
    const full = totalRefunded >= num(order.total);
    const created = await tx.refund.create({
      data: {
        orderId: order.id,
        paymentId: captured?.id,
        amount: input.amount,
        reason: input.reason,
        status: "PROCESSED",
        providerRefundId,
        items: input.items as Prisma.InputJsonValue | undefined,
        restock: !!input.restock,
        processedBy: input.actorName,
        processedAt: new Date(),
      },
    });
    if (input.items?.length) {
      for (const it of input.items) {
        const line = order.items.find((i) => i.id === it.orderItemId);
        if (!line) continue;
        const qty = Math.min(it.quantity, line.quantity - line.refundedQty);
        if (qty <= 0) continue;
        await tx.orderItem.update({ where: { id: line.id }, data: { refundedQty: { increment: qty } } });
        if (input.restock) await restockItems(tx, [{ variantId: line.variantId, quantity: qty }], "RETURN", order.id, input.actorName);
      }
    }
    if (captured && full) await tx.payment.update({ where: { id: captured.id }, data: { status: "REFUNDED" } });
    await tx.order.update({
      where: { id: order.id },
      data: {
        refundedAmount: totalRefunded,
        paymentStatus: full ? "REFUNDED" : "PARTIALLY_REFUNDED",
        events: {
          create: {
            title: full ? "Order refunded" : "Partial refund issued",
            note: `${formatInr(input.amount)}${input.reason ? ` · ${input.reason}` : ""}`,
            adminId: input.adminId,
          },
        },
      },
    });
    return created;
  });

  const refundVars = { ...orderEmailVars(order), refundAmount: formatInr(input.amount) };
  void getSetting("notifications").then(async (notif) => {
    if (notif.email.enabled && notif.email.events.refundProcessed) await sendTemplate("REFUND_PROCESSED", order.email, refundVars);
    await sendCustomerMessages("REFUND_PROCESSED", order.phone, refundVars);
  });
  return refund;
}

/** Background job: cancel online orders that never got paid. */
export async function cancelStaleUnpaidOrders() {
  const checkout = await getSetting("checkout");
  const cutoff = new Date(Date.now() - checkout.autoCancelUnpaidMinutes * 60_000);
  const stale = await prisma.order.findMany({
    where: { status: "PENDING", paymentStatus: { in: ["PENDING", "FAILED"] }, paymentMethod: { not: "COD" }, placedAt: { lt: cutoff }, source: "WEB" },
    select: { id: true },
    take: 50,
  });
  for (const o of stale) {
    await changeOrderStatus(o.id, "CANCELLED", { note: "Auto-cancelled: payment not completed", reason: "Payment not completed" }).catch((e) =>
      console.warn("[jobs] auto-cancel failed", o.id, e),
    );
  }
  return stale.length;
}
