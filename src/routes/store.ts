import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse } from "../lib/http";
import { requireCustomer } from "../middleware/auth";
import { buildQuote } from "../lib/pricing";
import { productCardInclude, toProductCard } from "../lib/catalog";
import { hashPassword, issueRefreshToken, verifyPassword } from "../lib/auth";
import { changeOrderStatus, STATUS_LABEL } from "../lib/orders";
import { invoicePdf } from "../lib/pdf";
import { storeUpload } from "../lib/storage";
import { serialize } from "../lib/utils";

const router = Router();
router.use(["/cart", "/wishlist", "/account", "/uploads"], requireCustomer);

const itemsSchema = z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(10) })).max(50);

// ───────────────────────────────── Cart ──────────────────────────────────────

async function cartResponse(customerId: string) {
  const cart = await prisma.cart.findUnique({ where: { customerId }, include: { items: { orderBy: { createdAt: "asc" } } } });
  const items = cart?.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) ?? [];
  return { items, couponCode: cart?.couponCode ?? null };
}

async function writeCart(customerId: string, items: { variantId: string; quantity: number }[], couponCode?: string | null) {
  const valid = await prisma.productVariant.findMany({ where: { id: { in: items.map((i) => i.variantId) } }, select: { id: true } });
  const ok = new Set(valid.map((v) => v.id));
  const cart = await prisma.cart.upsert({
    where: { customerId },
    create: { customerId, couponCode: couponCode ?? null },
    update: { couponCode: couponCode === undefined ? undefined : couponCode, recoveryEmailAt: null },
  });
  await prisma.$transaction([
    prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
    prisma.cartItem.createMany({
      data: items.filter((i) => ok.has(i.variantId)).map((i) => ({ cartId: cart.id, variantId: i.variantId, quantity: i.quantity })),
    }),
  ]);
}

router.get("/cart", async (req, res) => {
  res.json(await cartResponse(req.customer!.sub));
});

router.put("/cart", async (req, res) => {
  const body = parse(z.object({ items: itemsSchema, couponCode: z.string().nullable().optional() }), req.body);
  await writeCart(req.customer!.sub, body.items, body.couponCode);
  res.json(await cartResponse(req.customer!.sub));
});

/** Merge a guest (localStorage) bag into the account bag after login. */
router.post("/cart/merge", async (req, res) => {
  const body = parse(z.object({ items: itemsSchema }), req.body);
  const current = await cartResponse(req.customer!.sub);
  const merged = new Map(current.items.map((i) => [i.variantId, i.quantity]));
  for (const i of body.items) merged.set(i.variantId, Math.min(10, Math.max(merged.get(i.variantId) ?? 0, i.quantity)));
  await writeCart(req.customer!.sub, [...merged].map(([variantId, quantity]) => ({ variantId, quantity })));
  res.json(await cartResponse(req.customer!.sub));
});

// ─────────────────────────────── Wishlist ────────────────────────────────────

router.get("/wishlist", async (req, res) => {
  const rows = await prisma.wishlistItem.findMany({
    where: { customerId: req.customer!.sub },
    orderBy: { createdAt: "desc" },
    include: { product: { include: productCardInclude() } },
  });
  res.json(rows.filter((r) => r.product.status === "ACTIVE").map((r) => toProductCard(r.product)));
});

router.post("/wishlist", async (req, res) => {
  const { productId } = parse(z.object({ productId: z.string().min(1) }), req.body);
  await prisma.wishlistItem.upsert({
    where: { customerId_productId: { customerId: req.customer!.sub, productId } },
    create: { customerId: req.customer!.sub, productId },
    update: {},
  });
  res.status(201).json({ ok: true });
});

router.post("/wishlist/merge", async (req, res) => {
  const { productIds } = parse(z.object({ productIds: z.array(z.string()).max(100) }), req.body);
  const existing = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true } });
  await prisma.wishlistItem.createMany({
    data: existing.map((p) => ({ customerId: req.customer!.sub, productId: p.id })),
    skipDuplicates: true,
  });
  const ids = await prisma.wishlistItem.findMany({ where: { customerId: req.customer!.sub }, select: { productId: true } });
  res.json({ productIds: ids.map((i) => i.productId) });
});

router.delete("/wishlist/:productId", async (req, res) => {
  await prisma.wishlistItem.deleteMany({ where: { customerId: req.customer!.sub, productId: param(req, "productId") } });
  res.json({ ok: true });
});

// ─────────────────────────────── Profile ─────────────────────────────────────

const profileSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatarUrl: true,
  loyaltyPoints: true,
  dateOfBirth: true,
  anniversary: true,
  gender: true,
  acceptsMarketing: true,
  createdAt: true,
} as const;

router.get("/account/profile", async (req, res) => {
  res.json(await prisma.customer.findUniqueOrThrow({ where: { id: req.customer!.sub }, select: profileSelect }));
});

router.patch("/account/profile", async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80).optional(),
      phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid mobile number").optional().nullable(),
      dateOfBirth: z.coerce.date().optional().nullable(),
      anniversary: z.coerce.date().optional().nullable(),
      gender: z.string().max(20).optional().nullable(),
      acceptsMarketing: z.boolean().optional(),
    }),
    req.body,
  );
  const updated = await prisma.customer.update({ where: { id: req.customer!.sub }, data: body, select: profileSelect });
  res.json(updated);
});

router.post("/account/password", async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(8).max(100) }), req.body);
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: req.customer!.sub } });
  if (c.passwordHash && !(await verifyPassword(body.currentPassword ?? "", c.passwordHash))) {
    // 400, not 401: a 401 makes the storefront treat the session as expired.
    throw badRequest("Current password is incorrect");
  }
  await prisma.customer.update({ where: { id: c.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await prisma.refreshToken.deleteMany({ where: { customerId: c.id } });
  await issueRefreshToken(req, res, "customer", c.id);
  res.json({ ok: true });
});

router.get("/account/loyalty", async (req, res) => {
  const [customer, ledger] = await Promise.all([
    prisma.customer.findUniqueOrThrow({ where: { id: req.customer!.sub }, select: { loyaltyPoints: true } }),
    prisma.loyaltyTransaction.findMany({ where: { customerId: req.customer!.sub }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  res.json({ balance: customer.loyaltyPoints, ledger });
});

// ────────────────────────────── Addresses ────────────────────────────────────

export const addressSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  landmark: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().trim().regex(/^\d{6}$/, "Enter a valid 6-digit pincode"),
  country: z.string().default("India"),
  type: z.enum(["HOME", "WORK", "OTHER"]).default("HOME"),
  isDefault: z.boolean().optional(),
});

router.get("/account/addresses", async (req, res) => {
  res.json(await prisma.address.findMany({ where: { customerId: req.customer!.sub }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }));
});

router.post("/account/addresses", async (req, res) => {
  const body = parse(addressSchema, req.body);
  const customerId = req.customer!.sub;
  const count = await prisma.address.count({ where: { customerId } });
  const isDefault = body.isDefault || count === 0;
  if (isDefault) await prisma.address.updateMany({ where: { customerId }, data: { isDefault: false } });
  res.status(201).json(await prisma.address.create({ data: { ...body, customerId, isDefault } }));
});

router.patch("/account/addresses/:id", async (req, res) => {
  const body = parse(addressSchema.partial(), req.body);
  const customerId = req.customer!.sub;
  const addr = await prisma.address.findFirst({ where: { id: param(req, "id"), customerId } });
  if (!addr) throw notFound("Address not found");
  if (body.isDefault) await prisma.address.updateMany({ where: { customerId }, data: { isDefault: false } });
  res.json(await prisma.address.update({ where: { id: addr.id }, data: body }));
});

router.delete("/account/addresses/:id", async (req, res) => {
  await prisma.address.deleteMany({ where: { id: param(req, "id"), customerId: req.customer!.sub } });
  res.json({ ok: true });
});

// ─────────────────────────────── Orders ──────────────────────────────────────

router.get("/account/orders", async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const where = { customerId: req.customer!.sub };
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { placedAt: "desc" },
      skip,
      take,
      include: { items: { select: { name: true, image: true, quantity: true, variantTitle: true } } },
    }),
  ]);
  res.json(serialize({ items: rows.map((o) => ({ ...o, statusLabel: STATUS_LABEL[o.status] })), meta: pageMeta(total, page, limit) }));
});

async function ownOrder(customerId: string, orderNumber: string) {
  const order = await prisma.order.findFirst({
    where: { orderNumber, customerId },
    include: {
      items: true,
      events: { where: { isPublic: true }, orderBy: { createdAt: "asc" }, select: { status: true, title: true, note: true, createdAt: true } },
      shipments: { include: { events: { orderBy: { occurredAt: "desc" } } }, orderBy: { createdAt: "desc" } },
      refunds: { select: { amount: true, status: true, createdAt: true, reason: true } },
    },
  });
  if (!order) throw notFound("Order not found");
  return order;
}

router.get("/account/orders/:orderNumber", async (req, res) => {
  const order = await ownOrder(req.customer!.sub, param(req, "orderNumber"));
  const { internalNote: _i, ...safe } = order;
  res.json(serialize({ ...safe, statusLabel: STATUS_LABEL[order.status] }));
});

router.post("/account/orders/:orderNumber/cancel", async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});
  const order = await ownOrder(req.customer!.sub, param(req, "orderNumber"));
  if (!["PENDING", "CONFIRMED"].includes(order.status)) throw badRequest("This order can no longer be cancelled");
  await changeOrderStatus(order.id, "CANCELLED", { note: `Cancelled by customer${reason ? `: ${reason}` : ""}`, reason: reason ?? "Cancelled by customer" });
  res.json({ ok: true, message: order.paymentStatus === "PAID" ? "Order cancelled. Your refund will be processed within 5-7 business days." : "Order cancelled." });
});

router.post("/account/orders/:orderNumber/return", async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
  const order = await ownOrder(req.customer!.sub, param(req, "orderNumber"));
  if (order.status !== "DELIVERED") throw badRequest("Only delivered orders can be returned");
  const days = order.deliveredAt ? (Date.now() - order.deliveredAt.getTime()) / 86_400_000 : 0;
  if (days > 30) throw badRequest("The 30-day return window for this order has closed");
  await changeOrderStatus(order.id, "RETURN_REQUESTED", { note: `Return requested: ${reason}` });
  await prisma.notification.create({
    data: { type: "RETURN", title: `Return requested · ${order.orderNumber}`, body: reason, link: `/dashboard/orders/${order.id}` },
  });
  res.json({ ok: true, message: "Return requested. Our team will schedule a pickup within 48 hours." });
});

router.get("/account/orders/:orderNumber/invoice", async (req, res) => {
  const order = await ownOrder(req.customer!.sub, param(req, "orderNumber"));
  if (!order.invoiceNumber) throw badRequest("Invoice will be available once the order is confirmed");
  const pdf = await invoicePdf(order);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="invoice-${order.orderNumber}.pdf"`);
  res.send(pdf);
});

// ─────────────────────── Customer uploads (review photos) ───────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

router.post("/uploads/review", upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("Upload a JPG, PNG or WebP image under 5 MB");
  const stored = await storeUpload(req.file, "reviews");
  res.status(201).json({ url: stored.url });
});

/** Re-price the stored cart (used by the bag drawer for logged-in users). */
router.post("/cart/quote", async (req, res) => {
  const cart = await cartResponse(req.customer!.sub);
  res.json(await buildQuote({ items: cart.items, couponCode: cart.couponCode, customerId: req.customer!.sub }));
});

export default router;
