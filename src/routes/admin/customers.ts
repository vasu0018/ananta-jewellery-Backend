import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { registerCrud } from "../../lib/crud";
import { sendExport } from "../../lib/export";
import { num, round2, serialize } from "../../lib/utils";

const router = Router();
const read = requirePerm("customers.read");
const write = requirePerm("customers.write");

const PAID_STATUSES = { notIn: ["CANCELLED", "PENDING"] } as Prisma.EnumOrderStatusFilter;

function customerWhere(req: import("express").Request): Prisma.CustomerWhereInput {
  const q = queryString(req, "q");
  const status = queryString(req, "status");
  const tag = queryString(req, "tag");
  return {
    ...(status === "blocked" ? { isBlocked: true } : status === "active" ? { isBlocked: false } : {}),
    ...(status === "guest" ? { passwordHash: null } : status === "registered" ? { passwordHash: { not: null } } : {}),
    ...(tag ? { tags: { has: tag } } : {}),
    ...(queryString(req, "groupId") ? { groupId: queryString(req, "groupId") } : {}),
    ...(queryString(req, "marketing") === "1" ? { acceptsMarketing: true } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
          ],
        }
      : {}),
  };
}

async function orderStats(ids: string[]) {
  if (!ids.length) return new Map<string, { orders: number; spent: number; lastOrderAt: Date | null }>();
  const rows = await prisma.order.groupBy({
    by: ["customerId"],
    where: { customerId: { in: ids }, status: PAID_STATUSES },
    _count: { _all: true },
    _sum: { total: true, refundedAmount: true },
    _max: { placedAt: true },
  });
  return new Map(
    rows.map((r) => [
      r.customerId as string,
      { orders: r._count._all, spent: round2(num(r._sum.total) - num(r._sum.refundedAmount)), lastOrderAt: r._max.placedAt },
    ]),
  );
}

router.get("/customers", read, async (req, res) => {
  const where = customerWhere(req);
  const format = queryString(req, "format");
  const sort = queryString(req, "sort");

  if (format) {
    const rows = await prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, take: 20000, include: { group: { select: { name: true } } } });
    const stats = await orderStats(rows.map((r) => r.id));
    const data = rows.map((c) => ({ ...c, ...(stats.get(c.id) ?? { orders: 0, spent: 0, lastOrderAt: null }) }));
    await sendExport(res, format, "customers", data, [
      { key: "name", label: "Name", width: 22 },
      { key: "email", label: "Email", width: 28 },
      { key: "phone", label: "Phone" },
      { key: "orders", label: "Orders" },
      { key: "spent", label: "Total spent" },
      { key: "loyaltyPoints", label: "Points" },
      { key: "group", label: "Group", value: (c) => c.group?.name ?? "" },
      { key: "tags", label: "Tags", value: (c) => c.tags.join(", ") },
      { key: "acceptsMarketing", label: "Marketing", value: (c) => (c.acceptsMarketing ? "Yes" : "No") },
      { key: "isBlocked", label: "Blocked", value: (c) => (c.isBlocked ? "Yes" : "No") },
      { key: "createdAt", label: "Joined", value: (c) => c.createdAt.toISOString().slice(0, 10) },
    ]);
    return;
  }

  const { page, limit, skip, take } = pageArgs(req.query);
  // Sorting by spend needs the aggregate first; other sorts use the customer table directly.
  if (sort === "spent" || sort === "orders") {
    const agg = await prisma.order.groupBy({
      by: ["customerId"],
      where: { customerId: { not: null }, status: PAID_STATUSES, customer: where },
      _sum: { total: true },
      _count: { _all: true },
      orderBy: sort === "spent" ? { _sum: { total: "desc" } } : { _count: { customerId: "desc" } },
      skip,
      take,
    });
    const ids = agg.map((a) => a.customerId as string);
    const [total, customers, stats] = await Promise.all([
      prisma.customer.count({ where: { ...where, orders: { some: { status: PAID_STATUSES } } } }),
      prisma.customer.findMany({ where: { id: { in: ids } }, include: { group: { select: { id: true, name: true } } } }),
      orderStats(ids),
    ]);
    const items = ids.map((id) => customers.find((c) => c.id === id)!).filter(Boolean);
    res.json(serialize({ items: items.map((c) => present(c, stats)), meta: pageMeta(total, page, limit) }));
    return;
  }

  const orderBy: Prisma.CustomerOrderByWithRelationInput = sort === "name" ? { name: "asc" } : sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" };
  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({ where, orderBy, skip, take, include: { group: { select: { id: true, name: true } } } }),
  ]);
  const stats = await orderStats(customers.map((c) => c.id));
  res.json(serialize({ items: customers.map((c) => present(c, stats)), meta: pageMeta(total, page, limit) }));
});

function present(
  c: Prisma.CustomerGetPayload<{ include: { group: { select: { id: true; name: true } } } }>,
  stats: Map<string, { orders: number; spent: number; lastOrderAt: Date | null }>,
) {
  const s = stats.get(c.id) ?? { orders: 0, spent: 0, lastOrderAt: null };
  const { passwordHash, ...rest } = c;
  return { ...rest, isGuest: !passwordHash, ...s };
}

router.get("/customers/tags", read, async (_req, res) => {
  const rows = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
    SELECT unnest(tags) AS tag, COUNT(*) AS count FROM "Customer" GROUP BY 1 ORDER BY 2 DESC LIMIT 100`;
  res.json(rows.map((r) => ({ tag: r.tag, count: Number(r.count) })));
});

router.get("/customers/:id", read, async (req, res) => {
  const id = param(req, "id");
  const c = await prisma.customer.findUnique({
    where: { id },
    include: {
      group: true,
      addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
      orders: {
        orderBy: { placedAt: "desc" },
        take: 25,
        select: { id: true, orderNumber: true, placedAt: true, status: true, paymentStatus: true, paymentMethod: true, total: true, _count: { select: { items: true } } },
      },
      loyaltyLedger: { orderBy: { createdAt: "desc" }, take: 50 },
      reviews: { orderBy: { createdAt: "desc" }, take: 10, include: { product: { select: { name: true, slug: true } } } },
      wishlist: { take: 12, include: { product: { select: { id: true, name: true, slug: true, price: true, images: { take: 1, select: { url: true } } } } } },
      cart: { include: { items: { include: { variant: { select: { sku: true, title: true, product: { select: { name: true, price: true } } } } } } } },
      _count: { select: { orders: true, reviews: true, wishlist: true } },
    },
  });
  if (!c) throw notFound("Customer not found");
  const agg = await prisma.order.aggregate({
    where: { customerId: id, status: PAID_STATUSES },
    _sum: { total: true, refundedAmount: true },
    _count: true,
    _min: { placedAt: true },
    _max: { placedAt: true },
  });
  const ltv = round2(num(agg._sum.total) - num(agg._sum.refundedAmount));
  const topProducts = await prisma.$queryRaw<{ name: string; qty: bigint; revenue: number }[]>`
    SELECT oi.name, SUM(oi.quantity) AS qty, SUM(oi.total)::float AS revenue
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."customerId" = ${id} AND o.status NOT IN ('CANCELLED','PENDING')
    GROUP BY oi.name ORDER BY qty DESC LIMIT 5`;
  const { passwordHash, ...rest } = c;
  res.json(
    serialize({
      ...rest,
      isGuest: !passwordHash,
      stats: {
        orders: agg._count,
        lifetimeValue: ltv,
        averageOrderValue: agg._count ? round2(ltv / agg._count) : 0,
        firstOrderAt: agg._min.placedAt,
        lastOrderAt: agg._max.placedAt,
        totalOrders: c._count.orders,
      },
      topProducts: topProducts.map((t) => ({ name: t.name, quantity: Number(t.qty), revenue: t.revenue })),
    }),
  );
});

const customerUpdate = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  groupId: z.string().optional().nullable(),
  isBlocked: z.boolean().optional(),
  acceptsMarketing: z.boolean().optional(),
  gender: z.string().max(20).optional().nullable(),
  dateOfBirth: z.coerce.date().optional().nullable(),
  anniversary: z.coerce.date().optional().nullable(),
});

router.post("/customers", write, async (req, res) => {
  const body = parse(customerUpdate.extend({ name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email() }), req.body);
  const c = await prisma.customer.create({ data: body });
  await logActivity(req, "customer.create", "Customer", c.id, c.name);
  res.status(201).json({ id: c.id });
});

router.patch("/customers/:id", write, async (req, res) => {
  const id = param(req, "id");
  const body = parse(customerUpdate, req.body);
  const c = await prisma.customer.update({ where: { id }, data: body, omit: { passwordHash: true } });
  if (body.isBlocked) await prisma.refreshToken.deleteMany({ where: { customerId: id } });
  const action = body.isBlocked === true ? "customer.block" : body.isBlocked === false ? "customer.unblock" : "customer.update";
  await logActivity(req, action, "Customer", id, c.name);
  res.json(serialize(c));
});

router.post("/customers/:id/loyalty", write, async (req, res) => {
  const body = parse(z.object({ points: z.number().int().refine((n) => n !== 0, "Points cannot be zero"), note: z.string().trim().min(2).max(200) }), req.body);
  const id = param(req, "id");
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id } });
    if (!c) throw notFound("Customer not found");
    if (c.loyaltyPoints + body.points < 0) throw badRequest(`Customer only has ${c.loyaltyPoints} points`);
    await tx.loyaltyTransaction.create({ data: { customerId: id, type: "ADJUST", points: body.points, note: body.note } });
    return tx.customer.update({ where: { id }, data: { loyaltyPoints: { increment: body.points } }, select: { loyaltyPoints: true } });
  });
  await logActivity(req, "customer.loyalty", "Customer", id, `${body.points > 0 ? "+" : ""}${body.points} points`, { note: body.note });
  res.json(updated);
});

router.post("/customers/bulk", write, async (req, res) => {
  const body = parse(
    z.object({
      ids: z.array(z.string()).min(1).max(1000),
      action: z.enum(["block", "unblock", "addTag", "removeTag", "group"]),
      tag: z.string().trim().max(30).optional(),
      groupId: z.string().nullable().optional(),
    }),
    req.body,
  );
  const where = { id: { in: body.ids } };
  if (body.action === "block" || body.action === "unblock") {
    await prisma.customer.updateMany({ where, data: { isBlocked: body.action === "block" } });
  } else if (body.action === "group") {
    await prisma.customer.updateMany({ where, data: { groupId: body.groupId ?? null } });
  } else {
    if (!body.tag) throw badRequest("Tag is required");
    const rows = await prisma.customer.findMany({ where, select: { id: true, tags: true } });
    await prisma.$transaction(
      rows.map((r) =>
        prisma.customer.update({
          where: { id: r.id },
          data: { tags: body.action === "addTag" ? [...new Set([...r.tags, body.tag!])] : r.tags.filter((t) => t !== body.tag) },
        }),
      ),
    );
  }
  await logActivity(req, `customer.bulk.${body.action}`, "Customer", null, `${body.ids.length} customers`);
  res.json({ ok: true });
});

registerCrud(router, "/customer-groups", {
  model: prisma.customerGroup,
  area: "customers",
  entity: "CustomerGroup",
  createSchema: z.object({
    name: z.string().trim().min(2).max(60),
    description: z.string().max(300).optional().nullable(),
    discountPct: z.coerce.number().min(0).max(90).optional().nullable(),
  }),
  orderBy: { name: "asc" },
  include: { _count: { select: { customers: true } } },
  searchFields: ["name"],
});

export default router;
