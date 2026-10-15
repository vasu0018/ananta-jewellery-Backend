import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { pageArgs, pageMeta, param, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { lowStockVariants } from "../../lib/inventory";
import { addDays, pctChange, resolveRange, round2, serialize, startOfDay } from "../../lib/utils";

const router = Router();

/** Orders that count toward revenue: anything placed and not cancelled / unpaid-pending. */
const REVENUE_SQL = Prisma.sql`status NOT IN ('CANCELLED', 'PENDING')`;
const IST = Prisma.sql`("placedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;

async function totals(start: Date, end: Date) {
  const r = await prisma.$queryRaw<{ revenue: number | null; orders: number; refunds: number | null }[]>`
    SELECT COALESCE(SUM(total), 0)::float AS revenue, COUNT(*)::int AS orders, COALESCE(SUM("refundedAmount"), 0)::float AS refunds
    FROM "Order" WHERE "placedAt" >= ${start} AND "placedAt" <= ${end} AND ${REVENUE_SQL}`;
  const revenue = round2((r[0]?.revenue ?? 0) - (r[0]?.refunds ?? 0));
  const orders = r[0]?.orders ?? 0;
  return { revenue, orders, aov: orders ? round2(revenue / orders) : 0 };
}

async function visits(start: Date, end: Date) {
  const r = await prisma.dailyTraffic.aggregate({
    where: { date: { gte: startOfDay(start), lte: end } },
    _sum: { visits: true, productViews: true, addToCarts: true, checkouts: true },
  });
  return {
    visits: r._sum.visits ?? 0,
    productViews: r._sum.productViews ?? 0,
    addToCarts: r._sum.addToCarts ?? 0,
    checkouts: r._sum.checkouts ?? 0,
  };
}

function bucketKey(d: Date, unit: "day" | "month") {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return unit === "month" ? `${y}-${m}` : `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Revenue/orders time series with empty buckets filled in. */
export async function revenueSeries(start: Date, end: Date) {
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const unit: "day" | "month" = days > 120 ? "month" : "day";
  const rows = await prisma.$queryRaw<{ bucket: Date; revenue: number; orders: number }[]>`
    SELECT date_trunc(${unit}, ${IST}) AS bucket, COALESCE(SUM(total - "refundedAmount"), 0)::float AS revenue, COUNT(*)::int AS orders
    FROM "Order" WHERE "placedAt" >= ${start} AND "placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY 1 ORDER BY 1`;
  const traffic = await prisma.dailyTraffic.findMany({ where: { date: { gte: startOfDay(start), lte: end } } });
  const map = new Map(rows.map((r) => [bucketKey(new Date(r.bucket), unit), r]));
  const tmap = new Map<string, number>();
  for (const t of traffic) {
    const k = bucketKey(new Date(t.date.getUTCFullYear(), t.date.getUTCMonth(), t.date.getUTCDate()), unit);
    tmap.set(k, (tmap.get(k) ?? 0) + t.visits);
  }
  const out: { key: string; label: string; revenue: number; orders: number; visits: number }[] = [];
  const cursor = new Date(start);
  if (unit === "month") cursor.setDate(1);
  while (cursor <= end) {
    const key = bucketKey(cursor, unit);
    const hit = map.get(key);
    out.push({
      key,
      label:
        unit === "month"
          ? cursor.toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
          : cursor.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      revenue: round2(hit?.revenue ?? 0),
      orders: hit?.orders ?? 0,
      visits: tmap.get(key) ?? 0,
    });
    if (unit === "month") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

router.get("/dashboard", requirePerm("dashboard.read"), async (req, res) => {
  const range = queryString(req, "range") ?? "30d";
  const { start, end, prevStart, prevEnd } = resolveRange(range, queryString(req, "from"), queryString(req, "to"));
  const now = new Date();
  const today = startOfDay(now);

  const [curr, prev, trafficNow, trafficPrev, series, statusGroups, recentOrders, topRows, categoryRows, newCustomers, prevCustomers, lowStock, pendingReviews, openNdr, returnRequests, overview] =
    await Promise.all([
      totals(start, end),
      totals(prevStart, prevEnd),
      visits(start, end),
      visits(prevStart, prevEnd),
      revenueSeries(start, end),
      prisma.order.groupBy({ by: ["status"], where: { placedAt: { gte: start, lte: end } }, _count: { _all: true } }),
      prisma.order.findMany({
        orderBy: { placedAt: "desc" },
        take: 8,
        select: { id: true, orderNumber: true, customerName: true, phone: true, status: true, paymentStatus: true, paymentMethod: true, total: true, placedAt: true },
      }),
      prisma.$queryRaw<{ productId: string; name: string; sku: string; image: string | null; units: number; revenue: number }[]>`
        SELECT oi."productId", MAX(oi.name) AS name, MAX(oi.sku) AS sku, MAX(oi.image) AS image, SUM(oi.quantity)::int AS units, SUM(oi.total)::float AS revenue
        FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
        WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND o.status NOT IN ('CANCELLED','PENDING') AND oi."productId" IS NOT NULL
        GROUP BY oi."productId" ORDER BY revenue DESC LIMIT 8`,
      prisma.$queryRaw<{ category: string; revenue: number; units: number }[]>`
        SELECT COALESCE(c.name, 'Uncategorised') AS category, SUM(oi.total)::float AS revenue, SUM(oi.quantity)::int AS units
        FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
        LEFT JOIN "Product" p ON p.id = oi."productId" LEFT JOIN "Category" c ON c.id = p."categoryId"
        WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND o.status NOT IN ('CANCELLED','PENDING')
        GROUP BY 1 ORDER BY revenue DESC LIMIT 8`,
      prisma.customer.count({ where: { createdAt: { gte: start, lte: end } } }),
      prisma.customer.count({ where: { createdAt: { gte: prevStart, lte: prevEnd } } }),
      lowStockVariants(),
      prisma.review.count({ where: { status: "PENDING" } }),
      prisma.ndrCase.count({ where: { status: { in: ["OPEN", "REATTEMPT"] } } }),
      prisma.order.count({ where: { status: "RETURN_REQUESTED" } }),
      Promise.all([
        totals(today, now),
        totals(startOfDay(addDays(now, -6)), now),
        totals(new Date(now.getFullYear(), now.getMonth(), 1), now),
        totals(new Date(now.getFullYear(), 0, 1), now),
      ]),
    ]);

  const conversion = trafficNow.visits ? round2((curr.orders / trafficNow.visits) * 100) : 0;
  const prevConversion = trafficPrev.visits ? round2((prev.orders / trafficPrev.visits) * 100) : 0;

  res.json(
    serialize({
      range,
      from: start,
      to: end,
      kpis: {
        revenue: { value: curr.revenue, change: pctChange(curr.revenue, prev.revenue) },
        orders: { value: curr.orders, change: pctChange(curr.orders, prev.orders) },
        aov: { value: curr.aov, change: pctChange(curr.aov, prev.aov) },
        conversion: { value: conversion, change: round2(conversion - prevConversion), visits: trafficNow.visits },
        customers: { value: newCustomers, change: pctChange(newCustomers, prevCustomers) },
      },
      overview: {
        today: overview[0],
        week: overview[1],
        month: overview[2],
        year: overview[3],
      },
      funnel: trafficNow,
      series,
      ordersByStatus: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
      recentOrders,
      topProducts: topRows,
      categoryPerformance: categoryRows,
      lowStock: { count: lowStock.length, items: lowStock.slice(0, 8) },
      alerts: { pendingReviews, openNdr, returnRequests },
    }),
  );
});

/** Search across products, orders and customers for the admin command bar. */
router.get("/search", async (req, res) => {
  const q = (queryString(req, "q") ?? "").trim();
  if (q.length < 2) {
    res.json({ products: [], orders: [], customers: [] });
    return;
  }
  const contains = { contains: q, mode: "insensitive" as const };
  const [products, orders, customers] = await Promise.all([
    prisma.product.findMany({
      where: { OR: [{ name: contains }, { sku: contains }, { variants: { some: { sku: contains } } }] },
      take: 5,
      select: { id: true, name: true, sku: true, status: true, images: { take: 1, select: { url: true } } },
    }),
    prisma.order.findMany({
      where: { OR: [{ orderNumber: contains }, { email: contains }, { phone: contains }, { customerName: contains }] },
      take: 5,
      orderBy: { placedAt: "desc" },
      select: { id: true, orderNumber: true, customerName: true, total: true, status: true },
    }),
    prisma.customer.findMany({
      where: { OR: [{ name: contains }, { email: contains }, { phone: contains }] },
      take: 5,
      select: { id: true, name: true, email: true, phone: true },
    }),
  ]);
  res.json(serialize({ products, orders, customers }));
});

// ───────────────────────────── Notifications ─────────────────────────────────

/** Broadcast notifications (adminId null) form a shared team inbox; personal ones are per admin. */
const mine = (adminId: string): Prisma.NotificationWhereInput => ({ OR: [{ adminId: null }, { adminId }] });

router.get("/notifications", async (req, res) => {
  const unread = queryString(req, "unread") === "1";
  const type = queryString(req, "type");
  const where: Prisma.NotificationWhereInput = {
    ...mine(req.admin!.sub),
    ...(unread ? { readAt: null } : {}),
    ...(type ? { type } : {}),
  };
  const { page, limit, skip, take } = pageArgs(req.query);
  const [items, total, unreadCount, types] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...mine(req.admin!.sub), readAt: null } }),
    prisma.notification.groupBy({ by: ["type"], where: mine(req.admin!.sub), _count: { _all: true }, orderBy: { type: "asc" } }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), unreadCount, types: types.map((t) => ({ type: t.type, count: t._count._all })) });
});

router.post("/notifications/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { ...mine(req.admin!.sub), readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

router.post("/notifications/:id/read", async (req, res) => {
  await prisma.notification.updateMany({ where: { id: param(req, "id"), ...mine(req.admin!.sub) }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

router.post("/notifications/:id/unread", async (req, res) => {
  await prisma.notification.updateMany({ where: { id: param(req, "id"), ...mine(req.admin!.sub) }, data: { readAt: null } });
  res.json({ ok: true });
});

/** Sidebar badge counts. */
router.get("/counts", async (_req, res) => {
  const [pendingReviews, openNdr, returnRequests, toShip, newInquiries, unpaid] = await Promise.all([
    prisma.review.count({ where: { status: "PENDING" } }),
    prisma.ndrCase.count({ where: { status: { in: ["OPEN", "REATTEMPT"] } } }),
    prisma.order.count({ where: { status: "RETURN_REQUESTED" } }),
    prisma.order.count({ where: { status: { in: ["CONFIRMED", "PACKED"] } } }),
    prisma.inquiry.count({ where: { isRead: false } }),
    prisma.order.count({ where: { status: "PENDING" } }),
  ]);
  res.json({ pendingReviews, openNdr, returnRequests, toShip, newInquiries, unpaid });
});

export default router;
