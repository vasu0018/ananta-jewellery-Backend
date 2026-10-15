import crypto from "crypto";
import Razorpay from "razorpay";
import { getRazorpayConfig } from "./settings";
import { env } from "../config/env";
import { badRequest } from "./http";
import { randomToken } from "./utils";

async function client() {
  const cfg = await getRazorpayConfig();
  if (cfg.mock) {
    if (env.isProd) throw badRequest("Razorpay is not configured");
    return { cfg, rzp: null };
  }
  return { cfg, rzp: new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret }) };
}

const toPaise = (inr: number) => Math.round(inr * 100);

/** Create a Razorpay order (or a mock order when keys are not configured in dev). */
export async function createRazorpayOrder(amountInr: number, receipt: string, notes: Record<string, string>) {
  const { cfg, rzp } = await client();
  if (!rzp) {
    return { id: `order_mock_${randomToken(7)}`, amount: toPaise(amountInr), currency: "INR", keyId: "rzp_test_mock", mock: true };
  }
  const order = await rzp.orders.create({ amount: toPaise(amountInr), currency: "INR", receipt, notes });
  return { id: order.id, amount: Number(order.amount), currency: order.currency, keyId: cfg.keyId, mock: false };
}

export async function verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
  const cfg = await getRazorpayConfig();
  if (cfg.mock) return !env.isProd && orderId.startsWith("order_mock_");
  const expected = crypto.createHmac("sha256", cfg.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(expected, signature);
}

export async function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined) {
  const cfg = await getRazorpayConfig();
  if (!cfg.webhookSecret || !signature) return false;
  const expected = crypto.createHmac("sha256", cfg.webhookSecret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function fetchRazorpayPayment(paymentId: string) {
  const { rzp } = await client();
  if (!rzp) return null;
  return rzp.payments.fetch(paymentId);
}

/** Refund (full or partial). Returns provider refund id, or a mock id in dev. */
export async function refundRazorpayPayment(paymentId: string, amountInr: number, notes?: Record<string, string>) {
  const { rzp } = await client();
  if (!rzp || paymentId.startsWith("pay_mock_")) return { id: `rfnd_mock_${randomToken(6)}`, status: "processed" };
  const r = await rzp.payments.refund(paymentId, { amount: toPaise(amountInr), notes });
  return { id: r.id, status: r.status };
}

/** Settlements between two dates (unix seconds). */
export async function fetchRazorpaySettlements(from: Date, to: Date) {
  const { rzp } = await client();
  if (!rzp) return null;
  const res = await rzp.settlements.all({
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(to.getTime() / 1000),
    count: 100,
  });
  return res.items as unknown as {
    id: string;
    amount: number;
    fees: number;
    tax: number;
    utr: string;
    status: string;
    created_at: number;
  }[];
}
