import { Router } from "express";
import type { PaymentProvider, Prisma, TransactionStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { fetchRazorpayPayment, fetchRazorpaySettlements } from "../../lib/razorpay";
import { getRazorpayConfig } from "../../lib/settings";
import { sendExport } from "../../lib/export";
import { env } from "../../config/env";
import { addDays, num, randomToken, resolveRange, round2, serialize } from "../../lib/utils";

const router = Router();
const read = requirePerm("payments.read");

router.get("/payments/summary", read, async (req, res) => {
  const { start, end } = resolveRange(queryString(req, "range") ?? "30d", queryString(req, "from"), queryString(req, "to"));
  const period = { createdAt: { gte: start, lte: end } };
  const [captured, failed, refunds, byMethod, codOutstanding, unsettled, settlements, rzp] = await Promise.all([
    prisma.payment.aggregate({ where: { ...period, status: { in: ["CAPTURED", "REFUNDED"] } }, _sum: { amount: true, fee: true }, _count: true }),
    prisma.payment.count({ where: { ...period, status: "FAILED" } }),
    prisma.refund.aggregate({ where: { ...period, status: "PROCESSED" }, _sum: { amount: true }, _count: true }),
    prisma.payment.groupBy({ by: ["provider", "method"], where: { ...period, status: { in: ["CAPTURED", "REFUNDED"] } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.order.aggregate({
      where: { paymentMethod: "COD", paymentStatus: "PENDING", status: { in: ["CONFIRMED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY"] } },
      _sum: { total: true },
      _count: true,
    }),
    prisma.payment.aggregate({ where: { provider: "RAZORPAY", status: "CAPTURED", settlementId: null }, _sum: { amount: true }, _count: true }),
    prisma.settlement.aggregate({ where: { settledAt: { gte: start, lte: end } }, _sum: { amount: true, fees: true } }),
    getRazorpayConfig(),
  ]);
  const attempts = captured._count + failed;
  res.json({
    range: { start, end },
    collected: num(captured._sum.amount),
    transactions: captured._count,
    failed,
    successRate: attempts ? round2((captured._count / attempts) * 100) : 0,
    refunded: num(refunds._sum.amount),
    refundCount: refunds._count,
    net: round2(num(captured._sum.amount) - num(refunds._sum.amount)),
    gatewayFees: num(captured._sum.fee),
    codOutstanding: { amount: num(codOutstanding._sum.total), orders: codOutstanding._count },
    unsettled: { amount: num(unsettled._sum.amount), payments: unsettled._count },
    settled: { amount: num(settlements._sum.amount), fees: num(settlements._sum.fees) },
    byMethod: byMethod.map((m) => ({ provider: m.provider, method: m.method ?? m.provider, amount: num(m._sum.amount), count: m._count._all })),
    gateway: { enabled: rzp.enabled, mode: rzp.mode, mock: rzp.mock },
  });
});

router.get("/payments/transactions", read, async (req, res) => {
  const q = queryString(req, "q");
  const from = queryString(req, "from");
  const to = queryString(req, "to");
  const where: Prisma.PaymentWhereInput = {
    ...(queryString(req, "status") ? { status: queryString(req, "status") as TransactionStatus } : {}),
    ...(queryString(req, "provider") ? { provider: queryString(req, "provider") as PaymentProvider } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999+05:30`) } : {}) } } : {}),
    ...(q
      ? {
          OR: [
            { providerPaymentId: { contains: q, mode: "insensitive" } },
            { providerOrderId: { contains: q, mode: "insensitive" } },
            { order: { orderNumber: { contains: q, mode: "insensitive" } } },
            { order: { email: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const include = { order: { select: { id: true, orderNumber: true, customerName: true, email: true } } } satisfies Prisma.PaymentInclude;
  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.payment.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 10000 });
    await sendExport(res, format, "transactions", rows, [
      { key: "createdAt", label: "Date", value: (r) => r.createdAt.toISOString().slice(0, 16).replace("T", " ") },
      { key: "order", label: "Order", value: (r) => r.order.orderNumber },
      { key: "customer", label: "Customer", value: (r) => r.order.customerName },
      { key: "provider", label: "Provider" },
      { key: "method", label: "Method" },
      { key: "providerPaymentId", label: "Payment ID" },
      { key: "amount", label: "Amount", value: (r) => num(r.amount) },
      { key: "fee", label: "Fee", value: (r) => num(r.fee) },
      { key: "status", label: "Status" },
    ]);
    return;
  }
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take, omit: { raw: true } }),
  ]);
  res.json(serialize({ items, meta: pageMeta(total, page, limit) }));
});

router.get("/payments/transactions/:id", read, async (req, res) => {
  const p = await prisma.payment.findUnique({
    where: { id: param(req, "id") },
    include: { order: { select: { id: true, orderNumber: true, customerName: true, email: true, total: true } }, refunds: true, settlement: true },
  });
  if (!p) throw notFound("Transaction not found");
  res.json(serialize(p));
});

/** Re-fetch a payment from Razorpay (fees, method, status). */
router.post("/payments/transactions/:id/refresh", requirePerm("payments.read"), async (req, res) => {
  const p = await prisma.payment.findUnique({ where: { id: param(req, "id") } });
  if (!p?.providerPaymentId || p.provider !== "RAZORPAY") throw badRequest("Only Razorpay payments can be refreshed");
  const remote = (await fetchRazorpayPayment(p.providerPaymentId)) as { method?: string; fee?: number; tax?: number; status?: string } | null;
  if (!remote) {
    res.json({ ok: false, message: "Razorpay is running in mock mode" });
    return;
  }
  const updated = await prisma.payment.update({
    where: { id: p.id },
    data: { method: remote.method ?? p.method, fee: remote.fee ? remote.fee / 100 : p.fee, tax: remote.tax ? remote.tax / 100 : p.tax, raw: remote as object },
  });
  res.json(serialize(updated));
});

router.get("/payments/refunds", read, async (req, res) => {
  const q = queryString(req, "q");
  const where: Prisma.RefundWhereInput = q
    ? { OR: [{ providerRefundId: { contains: q, mode: "insensitive" } }, { order: { orderNumber: { contains: q, mode: "insensitive" } } }] }
    : {};
  const include = { order: { select: { id: true, orderNumber: true, customerName: true, paymentMethod: true } } } satisfies Prisma.RefundInclude;
  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.refund.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 10000 });
    await sendExport(res, format, "refunds", rows, [
      { key: "createdAt", label: "Date", value: (r) => r.createdAt.toISOString().slice(0, 10) },
      { key: "order", label: "Order", value: (r) => r.order.orderNumber },
      { key: "customer", label: "Customer", value: (r) => r.order.customerName },
      { key: "amount", label: "Amount", value: (r) => num(r.amount) },
      { key: "reason", label: "Reason" },
      { key: "status", label: "Status" },
      { key: "providerRefundId", label: "Refund ID" },
      { key: "processedBy", label: "By" },
    ]);
    return;
  }
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items] = await Promise.all([
    prisma.refund.count({ where }),
    prisma.refund.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }),
  ]);
  res.json(serialize({ items, meta: pageMeta(total, page, limit) }));
});

router.get("/payments/settlements", read, async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items] = await Promise.all([
    prisma.settlement.count(),
    prisma.settlement.findMany({ orderBy: { settledAt: "desc" }, skip, take, include: { _count: { select: { payments: true } } } }),
  ]);
  res.json(serialize({ items, meta: pageMeta(total, page, limit) }));
});

/**
 * Pull settlements from Razorpay. In mock mode (no keys, non-production) a simulated
 * T+2 settlement is generated from captured, unsettled payments so the flow can be tested.
 */
router.post("/payments/settlements/sync", requirePerm("payments.read"), async (req, res) => {
  const body = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.body ?? {});
  const to = body.to ? new Date(body.to) : new Date();
  const from = body.from ? new Date(body.from) : addDays(to, -30);
  const remote = await fetchRazorpaySettlements(from, to);
  let created = 0;
  if (remote) {
    for (const s of remote) {
      await prisma.settlement.upsert({
        where: { settlementId: s.id },
        create: { settlementId: s.id, amount: s.amount / 100, fees: s.fees / 100, tax: s.tax / 100, utr: s.utr, status: s.status, settledAt: new Date(s.created_at * 1000) },
        update: { status: s.status, utr: s.utr },
      });
      created++;
    }
  } else if (!env.isProd) {
    const pending = await prisma.payment.findMany({
      where: { provider: "RAZORPAY", status: "CAPTURED", settlementId: null, capturedAt: { lte: addDays(new Date(), -2) } },
      select: { id: true, amount: true },
    });
    if (pending.length) {
      const gross = pending.reduce((s, p) => s + num(p.amount), 0);
      const fees = round2(gross * 0.02);
      const tax = round2(fees * 0.18);
      const settlement = await prisma.settlement.create({
        data: { settlementId: `setl_mock_${randomToken(6)}`, amount: round2(gross - fees - tax), fees, tax, utr: `MOCKUTR${Date.now()}`, settledAt: new Date() },
      });
      await prisma.payment.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { settlementId: settlement.id } });
      created = 1;
    }
  }
  await logActivity(req, "settlement.sync", "Settlement", null, `${created} settlements synced`);
  res.json({ ok: true, synced: created, mock: !remote });
});

router.get("/payments/settlements/:id", read, async (req, res) => {
  const s = await prisma.settlement.findUnique({
    where: { id: param(req, "id") },
    include: { payments: { include: { order: { select: { orderNumber: true, customerName: true } } }, omit: { raw: true } } },
  });
  if (!s) throw notFound("Settlement not found");
  res.json(serialize(s));
});

export default router;
