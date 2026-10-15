import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { getSetting } from "../../lib/settings";
import { sendExport, type Column } from "../../lib/export";
import { num, resolveRange, round2 } from "../../lib/utils";

const router = Router();
const read = requirePerm("reports.read");

const REVENUE_SQL = Prisma.sql`o.status NOT IN ('CANCELLED', 'PENDING')`;
const IST = Prisma.sql`(o."placedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;

function range(req: Request) {
  return resolveRange(queryString(req, "range") ?? "30d", queryString(req, "from"), queryString(req, "to"));
}

/** JSON by default; csv / xlsx / pdf when ?format is given. */
async function respond<T extends Record<string, unknown>>(
  req: Request,
  res: Response,
  name: string,
  rows: T[],
  columns: Column<T>[],
  extra: Record<string, unknown> = {},
) {
  if (await sendExport(res, queryString(req, "format"), name, rows, columns)) return;
  res.json({ rows, columns: columns.map((c) => ({ key: c.key, label: c.label })), ...extra });
}

function sumBy<T>(rows: T[], key: keyof T) {
  return round2(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0));
}

// ──────────────────────────────────── Sales ──────────────────────────────────

router.get("/reports/sales", read, async (req, res) => {
  const { start, end } = range(req);
  const unit = (["day", "week", "month"] as const).find((u) => u === queryString(req, "groupBy")) ?? "day";
  const raw = await prisma.$queryRaw<
    { bucket: Date; orders: number; items: number; gross: number; discount: number; shipping: number; tax: number; refunds: number; total: number }[]
  >`
    SELECT date_trunc(${unit}, ${IST}) AS bucket,
      COUNT(*)::int AS orders,
      COALESCE(SUM((SELECT SUM(quantity) FROM "OrderItem" WHERE "orderId" = o.id)), 0)::int AS items,
      COALESCE(SUM(o.subtotal), 0)::float AS gross,
      COALESCE(SUM(o.discount + o."loyaltyDiscount"), 0)::float AS discount,
      COALESCE(SUM(o."shippingFee" + o."codFee" + o."giftWrapFee"), 0)::float AS shipping,
      COALESCE(SUM(o."taxTotal"), 0)::float AS tax,
      COALESCE(SUM(o."refundedAmount"), 0)::float AS refunds,
      COALESCE(SUM(o.total), 0)::float AS total
    FROM "Order" o
    WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY 1 ORDER BY 1`;
  const rows = raw.map((r) => ({
    period: new Date(r.bucket).toISOString().slice(0, unit === "month" ? 7 : 10),
    orders: r.orders,
    items: r.items,
    gross: round2(r.gross),
    discount: round2(r.discount),
    shipping: round2(r.shipping),
    tax: round2(r.tax),
    refunds: round2(r.refunds),
    net: round2(r.total - r.refunds),
    aov: r.orders ? round2(r.total / r.orders) : 0,
  }));
  const totals = {
    orders: sumBy(rows, "orders"),
    items: sumBy(rows, "items"),
    gross: sumBy(rows, "gross"),
    discount: sumBy(rows, "discount"),
    shipping: sumBy(rows, "shipping"),
    tax: sumBy(rows, "tax"),
    refunds: sumBy(rows, "refunds"),
    net: sumBy(rows, "net"),
  };
  await respond(
    req,
    res,
    "sales-report",
    rows,
    [
      { key: "period", label: "Period" },
      { key: "orders", label: "Orders" },
      { key: "items", label: "Units" },
      { key: "gross", label: "Gross sales" },
      { key: "discount", label: "Discounts" },
      { key: "shipping", label: "Shipping & fees" },
      { key: "tax", label: "GST" },
      { key: "refunds", label: "Refunds" },
      { key: "net", label: "Net sales" },
      { key: "aov", label: "AOV" },
    ],
    { totals: { ...totals, aov: totals.orders ? round2((totals.net + totals.refunds) / totals.orders) : 0 }, groupBy: unit },
  );
});

// ─────────────────────────────────── Products ────────────────────────────────

router.get("/reports/products", read, async (req, res) => {
  const { start, end } = range(req);
  const raw = await prisma.$queryRaw<{ productId: string | null; name: string; sku: string; category: string | null; qty: number; orders: number; revenue: number; refundedQty: number; cost: number | null }[]>`
    SELECT oi."productId", MAX(oi.name) AS name, MAX(p.sku) AS sku, MAX(c.name) AS category,
      SUM(oi.quantity)::int AS qty, COUNT(DISTINCT o.id)::int AS orders, SUM(oi.total)::float AS revenue,
      SUM(oi."refundedQty")::int AS "refundedQty", (SUM(oi.quantity) * MAX(p."costPrice"))::float AS cost
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Product" p ON p.id = oi."productId"
    LEFT JOIN "Category" c ON c.id = p."categoryId"
    WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY oi."productId" ORDER BY revenue DESC LIMIT 500`;
  const rows = raw.map((r) => ({
    product: r.name,
    sku: r.sku ?? "",
    category: r.category ?? "",
    unitsSold: r.qty,
    orders: r.orders,
    revenue: round2(r.revenue),
    returned: r.refundedQty,
    margin: r.cost != null ? round2(r.revenue - r.cost) : null,
  }));
  await respond(
    req,
    res,
    "product-sales",
    rows,
    [
      { key: "product", label: "Product", width: 30 },
      { key: "sku", label: "SKU" },
      { key: "category", label: "Category" },
      { key: "unitsSold", label: "Units sold" },
      { key: "orders", label: "Orders" },
      { key: "revenue", label: "Revenue" },
      { key: "returned", label: "Returned" },
      { key: "margin", label: "Gross margin" },
    ],
    { totals: { unitsSold: sumBy(rows, "unitsSold"), revenue: sumBy(rows, "revenue") } },
  );
});

// ────────────────────────────────── Categories ───────────────────────────────

router.get("/reports/categories", read, async (req, res) => {
  const { start, end } = range(req);
  const raw = await prisma.$queryRaw<{ category: string | null; products: number; qty: number; orders: number; revenue: number }[]>`
    SELECT COALESCE(c.name, 'Uncategorised') AS category, COUNT(DISTINCT oi."productId")::int AS products,
      SUM(oi.quantity)::int AS qty, COUNT(DISTINCT o.id)::int AS orders, SUM(oi.total)::float AS revenue
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Product" p ON p.id = oi."productId"
    LEFT JOIN "Category" c ON c.id = p."categoryId"
    WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY 1 ORDER BY revenue DESC`;
  const total = raw.reduce((s, r) => s + r.revenue, 0);
  const rows = raw.map((r) => ({
    category: r.category ?? "Uncategorised",
    products: r.products,
    unitsSold: r.qty,
    orders: r.orders,
    revenue: round2(r.revenue),
    share: total ? round2((r.revenue / total) * 100) : 0,
  }));
  await respond(req, res, "category-sales", rows, [
    { key: "category", label: "Category", width: 24 },
    { key: "products", label: "Products sold" },
    { key: "unitsSold", label: "Units" },
    { key: "orders", label: "Orders" },
    { key: "revenue", label: "Revenue" },
    { key: "share", label: "Share %" },
  ]);
});

// ────────────────────────────────── Customers ────────────────────────────────

router.get("/reports/customers", read, async (req, res) => {
  const { start, end } = range(req);
  const raw = await prisma.$queryRaw<{ id: string; name: string; email: string; phone: string | null; orders: number; spent: number; first: Date; last: Date; lifetimeOrders: number }[]>`
    SELECT c.id, c.name, c.email, c.phone, COUNT(o.id)::int AS orders, SUM(o.total - o."refundedAmount")::float AS spent,
      MIN(o."placedAt") AS first, MAX(o."placedAt") AS last,
      (SELECT COUNT(*) FROM "Order" x WHERE x."customerId" = c.id AND x.status NOT IN ('CANCELLED','PENDING'))::int AS "lifetimeOrders"
    FROM "Order" o JOIN "Customer" c ON c.id = o."customerId"
    WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY c.id ORDER BY spent DESC LIMIT 500`;
  const [newCustomers, returning] = await Promise.all([
    prisma.customer.count({ where: { createdAt: { gte: start, lte: end } } }),
    Promise.resolve(raw.filter((r) => r.lifetimeOrders > r.orders).length),
  ]);
  const rows = raw.map((r) => ({
    name: r.name,
    email: r.email,
    phone: r.phone ?? "",
    orders: r.orders,
    spent: round2(r.spent),
    aov: r.orders ? round2(r.spent / r.orders) : 0,
    lifetimeOrders: r.lifetimeOrders,
    type: r.lifetimeOrders > r.orders ? "Returning" : "New",
    lastOrder: new Date(r.last).toISOString().slice(0, 10),
  }));
  await respond(
    req,
    res,
    "customer-report",
    rows,
    [
      { key: "name", label: "Customer", width: 22 },
      { key: "email", label: "Email", width: 28 },
      { key: "phone", label: "Phone" },
      { key: "orders", label: "Orders" },
      { key: "spent", label: "Spent" },
      { key: "aov", label: "AOV" },
      { key: "lifetimeOrders", label: "Lifetime orders" },
      { key: "type", label: "Type" },
      { key: "lastOrder", label: "Last order" },
    ],
    { summary: { newCustomers, purchasingCustomers: raw.length, returning, repeatRate: raw.length ? round2((returning / raw.length) * 100) : 0 } },
  );
});

// ────────────────────────────────── Inventory ────────────────────────────────

router.get("/reports/inventory", read, async (req, res) => {
  const variants = await prisma.productVariant.findMany({
    where: { product: { status: { not: "ARCHIVED" } } },
    select: {
      sku: true,
      title: true,
      price: true,
      product: { select: { name: true, price: true, costPrice: true, category: { select: { name: true } } } },
      inventory: { where: { warehouse: { isActive: true } }, select: { quantity: true, reserved: true, lowStockThreshold: true } },
    },
    orderBy: { product: { name: "asc" } },
  });
  const rows = variants.map((v) => {
    const qty = v.inventory.reduce((s, l) => s + l.quantity, 0);
    const reserved = v.inventory.reduce((s, l) => s + l.reserved, 0);
    const price = num(v.price ?? v.product.price);
    const cost = num(v.product.costPrice);
    const threshold = v.inventory.length ? Math.max(...v.inventory.map((l) => l.lowStockThreshold)) : 5;
    return {
      sku: v.sku,
      product: v.product.name,
      variant: v.title,
      category: v.product.category?.name ?? "",
      onHand: qty,
      reserved,
      costValue: round2(qty * cost),
      retailValue: round2(qty * price),
      status: qty - reserved <= 0 ? "Out of stock" : qty - reserved <= threshold ? "Low" : "In stock",
    };
  });
  await respond(
    req,
    res,
    "inventory-valuation",
    rows,
    [
      { key: "sku", label: "SKU" },
      { key: "product", label: "Product", width: 28 },
      { key: "variant", label: "Variant" },
      { key: "category", label: "Category" },
      { key: "onHand", label: "On hand" },
      { key: "reserved", label: "Reserved" },
      { key: "costValue", label: "Value at cost" },
      { key: "retailValue", label: "Value at retail" },
      { key: "status", label: "Status" },
    ],
    { totals: { units: sumBy(rows, "onHand"), costValue: sumBy(rows, "costValue"), retailValue: sumBy(rows, "retailValue") } },
  );
});

// ───────────────────────────────── GST / tax ─────────────────────────────────

router.get("/reports/tax", read, async (req, res) => {
  const { start, end } = range(req);
  const store = await getSetting("store");
  const raw = await prisma.$queryRaw<{ month: Date; state: string | null; orders: number; total: number; tax: number }[]>`
    SELECT date_trunc('month', ${IST}) AS month, o."shippingAddress"->>'state' AS state, COUNT(*)::int AS orders,
      SUM(o.total - o."refundedAmount")::float AS total, SUM(o."taxTotal")::float AS tax
    FROM "Order" o
    WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY 1, 2 ORDER BY 1, 2`;
  const home = (store.state ?? "").toLowerCase();
  const rows = raw.map((r) => {
    const intra = (r.state ?? "").toLowerCase() === home;
    const tax = round2(r.tax);
    return {
      month: new Date(r.month).toISOString().slice(0, 7),
      state: r.state ?? "",
      orders: r.orders,
      taxableValue: round2(r.total - r.tax),
      cgst: intra ? round2(tax / 2) : 0,
      sgst: intra ? round2(tax / 2) : 0,
      igst: intra ? 0 : tax,
      totalTax: tax,
      invoiceValue: round2(r.total),
    };
  });
  await respond(
    req,
    res,
    "gst-report",
    rows,
    [
      { key: "month", label: "Month" },
      { key: "state", label: "Place of supply", width: 20 },
      { key: "orders", label: "Invoices" },
      { key: "taxableValue", label: "Taxable value" },
      { key: "cgst", label: "CGST" },
      { key: "sgst", label: "SGST" },
      { key: "igst", label: "IGST" },
      { key: "totalTax", label: "Total GST" },
      { key: "invoiceValue", label: "Invoice value" },
    ],
    {
      totals: {
        taxableValue: sumBy(rows, "taxableValue"),
        cgst: sumBy(rows, "cgst"),
        sgst: sumBy(rows, "sgst"),
        igst: sumBy(rows, "igst"),
        totalTax: sumBy(rows, "totalTax"),
      },
      homeState: store.state,
    },
  );
});

// ─────────────────────────────── Payment methods ─────────────────────────────

router.get("/reports/payments", read, async (req, res) => {
  const { start, end } = range(req);
  const raw = await prisma.$queryRaw<{ method: string; orders: number; total: number; refunds: number }[]>`
    SELECT o."paymentMethod"::text AS method, COUNT(*)::int AS orders, SUM(o.total)::float AS total, SUM(o."refundedAmount")::float AS refunds
    FROM "Order" o
    WHERE o."placedAt" >= ${start} AND o."placedAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY 1 ORDER BY total DESC`;
  const sum = raw.reduce((s, r) => s + r.total, 0);
  const rows = raw.map((r) => ({
    method: r.method === "COD" ? "Cash on Delivery" : r.method === "RAZORPAY" ? "Online (Razorpay)" : r.method,
    orders: r.orders,
    amount: round2(r.total),
    refunds: round2(r.refunds),
    share: sum ? round2((r.total / sum) * 100) : 0,
  }));
  await respond(req, res, "payment-methods", rows, [
    { key: "method", label: "Method", width: 22 },
    { key: "orders", label: "Orders" },
    { key: "amount", label: "Amount" },
    { key: "refunds", label: "Refunds" },
    { key: "share", label: "Share %" },
  ]);
});

// ─────────────────────────────────── Coupons ─────────────────────────────────

router.get("/reports/coupons", read, async (req, res) => {
  const { start, end } = range(req);
  const raw = await prisma.$queryRaw<{ code: string; type: string; uses: number; discount: number; revenue: number }[]>`
    SELECT c.code, c.type::text AS type, COUNT(r.id)::int AS uses, SUM(r.discount)::float AS discount, SUM(o.total)::float AS revenue
    FROM "CouponRedemption" r
    JOIN "Coupon" c ON c.id = r."couponId"
    JOIN "Order" o ON o.id = r."orderId"
    WHERE r."createdAt" >= ${start} AND r."createdAt" <= ${end} AND ${REVENUE_SQL}
    GROUP BY c.code, c.type ORDER BY uses DESC`;
  const rows = raw.map((r) => ({ code: r.code, type: r.type, uses: r.uses, discount: round2(r.discount), revenue: round2(r.revenue) }));
  await respond(req, res, "coupon-report", rows, [
    { key: "code", label: "Code" },
    { key: "type", label: "Type" },
    { key: "uses", label: "Uses" },
    { key: "discount", label: "Discount given" },
    { key: "revenue", label: "Order revenue" },
  ]);
});

export default router;
