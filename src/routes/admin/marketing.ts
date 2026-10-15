import { Router } from "express";
import type { Prisma, SubscriberStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { registerCrud } from "../../lib/crud";
import { renderEmail, SAMPLE_EMAIL_VARS, sendMail } from "../../lib/mailer";
import { abandonedCarts, sendCartReminder } from "../../lib/abandoned";
import { sendExport } from "../../lib/export";
import { num, round2, serialize, slugify } from "../../lib/utils";
import { richText } from "../../lib/html";

const router = Router();
const read = requirePerm("marketing.read");
const write = requirePerm("marketing.write");

/** Optional date where null / "" clear the value (z.coerce.date would turn null into 1970-01-01). */
const optDate = z.preprocess((v) => (v === "" || v === null ? null : v), z.coerce.date().nullable()).optional();

// ───────────────────────────────── Coupons ───────────────────────────────────

const couponSchema = z
  .object({
    code: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, - or _"),
    description: z.string().max(300).optional().nullable(),
    type: z.enum(["PERCENTAGE", "FIXED", "FREE_SHIPPING", "BUY_X_GET_Y"]),
    value: z.coerce.number().min(0).default(0),
    maxDiscount: z.coerce.number().min(0).nullable().optional(),
    minOrderValue: z.coerce.number().min(0).nullable().optional(),
    buyQuantity: z.coerce.number().int().min(1).nullable().optional(),
    getQuantity: z.coerce.number().int().min(1).nullable().optional(),
    scope: z.enum(["ALL", "CATEGORY", "PRODUCT", "COLLECTION"]).default("ALL"),
    scopeIds: z.array(z.string()).default([]),
    usageLimit: z.coerce.number().int().min(1).nullable().optional(),
    usagePerCustomer: z.coerce.number().int().min(1).nullable().optional(),
    firstOrderOnly: z.boolean().default(false),
    isPublic: z.boolean().default(true),
    isActive: z.boolean().default(true),
    startsAt: optDate,
    endsAt: optDate,
  })
  .superRefine((c, ctx) => {
    if (c.type === "PERCENTAGE" && (c.value <= 0 || c.value > 90)) ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage must be 1–90" });
    if (c.type === "FIXED" && c.value <= 0) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter a discount amount" });
    if (c.type === "BUY_X_GET_Y" && (!c.buyQuantity || !c.getQuantity)) ctx.addIssue({ code: "custom", path: ["buyQuantity"], message: "Buy and get quantities are required" });
    if (c.scope !== "ALL" && !c.scopeIds.length) ctx.addIssue({ code: "custom", path: ["scopeIds"], message: "Select at least one item for this scope" });
    if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after start date" });
  });

registerCrud(router, "/marketing/coupons", {
  model: prisma.coupon,
  area: "marketing",
  entity: "Coupon",
  createSchema: couponSchema,
  updateSchema: couponSchema,
  paginate: true,
  include: { _count: { select: { redemptions: true } } },
  searchFields: ["code", "description"],
  listWhere: (req) => {
    const s = queryString(req, "status");
    const now = new Date();
    if (s === "active") return { isActive: true, OR: [{ endsAt: null }, { endsAt: { gte: now } }] };
    if (s === "expired") return { endsAt: { lt: now } };
    if (s === "inactive") return { isActive: false };
    return {};
  },
  transform: (data) => ({ ...data, code: data.code ? String(data.code).toUpperCase() : data.code }),
});

router.get("/marketing/coupons/:id/redemptions", read, async (req, res) => {
  const id = param(req, "id");
  const [rows, agg] = await Promise.all([
    prisma.couponRedemption.findMany({
      where: { couponId: id },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { order: { select: { id: true, orderNumber: true, customerName: true, total: true, placedAt: true } } },
    }),
    prisma.couponRedemption.aggregate({ where: { couponId: id }, _sum: { discount: true }, _count: true }),
  ]);
  const revenue = rows.reduce((s, r) => s + num(r.order.total), 0);
  res.json(serialize({ items: rows, totals: { redemptions: agg._count, discount: num(agg._sum.discount), revenue: round2(revenue) } }));
});

// ─────────────────────────────── Flash sales ─────────────────────────────────

const flashSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().max(300).optional().nullable(),
    discountType: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
    discountValue: z.coerce.number().positive(),
    bannerImage: z.string().optional().nullable(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    isActive: z.boolean().default(true),
    productIds: z.array(z.string()).default([]),
  })
  .refine((f) => f.endsAt > f.startsAt, { path: ["endsAt"], message: "End must be after start" })
  .refine((f) => f.discountType !== "PERCENTAGE" || f.discountValue <= 90, { path: ["discountValue"], message: "Max 90%" });

function flashState(f: { isActive: boolean; startsAt: Date; endsAt: Date }) {
  const now = new Date();
  if (!f.isActive) return "INACTIVE";
  if (f.startsAt > now) return "SCHEDULED";
  if (f.endsAt < now) return "ENDED";
  return "LIVE";
}

router.get("/marketing/flash-sales", read, async (_req, res) => {
  const rows = await prisma.flashSale.findMany({ orderBy: { startsAt: "desc" }, include: { _count: { select: { products: true } } } });
  res.json(serialize(rows.map((f) => ({ ...f, state: flashState(f) }))));
});

router.get("/marketing/flash-sales/:id", read, async (req, res) => {
  const f = await prisma.flashSale.findUnique({
    where: { id: param(req, "id") },
    include: { products: { select: { id: true, name: true, sku: true, price: true, images: { take: 1, select: { url: true } } } } },
  });
  if (!f) throw notFound("Flash sale not found");
  res.json(serialize({ ...f, state: flashState(f), productIds: f.products.map((p) => p.id) }));
});

router.post("/marketing/flash-sales", write, async (req, res) => {
  const { productIds, ...data } = parse(flashSchema, req.body);
  const f = await prisma.flashSale.create({ data: { ...data, products: { connect: productIds.map((id) => ({ id })) } } });
  await logActivity(req, "flash_sale.create", "FlashSale", f.id, f.name);
  res.status(201).json(serialize(f));
});

router.patch("/marketing/flash-sales/:id", write, async (req, res) => {
  const id = param(req, "id");
  const current = await prisma.flashSale.findUnique({ where: { id }, include: { products: { select: { id: true } } } });
  if (!current) throw notFound("Flash sale not found");
  // Partial updates (e.g. just `isActive`) are merged over the stored sale, then validated as a whole.
  const { products, ...stored } = current;
  const { productIds, ...data } = parse(flashSchema, {
    ...stored,
    discountValue: num(stored.discountValue),
    productIds: products.map((p) => p.id),
    ...req.body,
  });
  const f = await prisma.flashSale.update({
    where: { id },
    data: { ...data, products: { set: productIds.map((id) => ({ id })) } },
  });
  await logActivity(req, "flash_sale.update", "FlashSale", f.id, f.name);
  res.json(serialize(f));
});

router.delete("/marketing/flash-sales/:id", write, async (req, res) => {
  await prisma.flashSale.delete({ where: { id: param(req, "id") } });
  await logActivity(req, "flash_sale.delete", "FlashSale", param(req, "id"));
  res.json({ ok: true });
});

// ───────────────────────────────── Banners ───────────────────────────────────

registerCrud(router, "/marketing/banners", {
  model: prisma.banner,
  area: "marketing",
  entity: "Banner",
  createSchema: z.object({
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().max(300).optional().nullable(),
    eyebrow: z.string().max(60).optional().nullable(),
    image: z.string().min(1),
    mobileImage: z.string().optional().nullable(),
    link: z.string().max(300).optional().nullable(),
    ctaLabel: z.string().max(40).optional().nullable(),
    placement: z.enum(["HOME_HERO", "HOME_STRIP", "HOME_PROMO", "CATEGORY", "GIFTING"]).default("HOME_HERO"),
    categoryId: z.string().optional().nullable(),
    textColor: z.string().max(20).optional().nullable(),
    sortOrder: z.coerce.number().int().default(0),
    isActive: z.boolean().default(true),
    startsAt: optDate,
    endsAt: optDate,
  }),
  orderBy: [{ placement: "asc" }, { sortOrder: "asc" }],
  searchFields: ["title", "subtitle"],
  listWhere: (req) => (queryString(req, "placement") ? { placement: queryString(req, "placement") } : {}),
});

// ───────────────────────────── Email templates ───────────────────────────────

router.get("/marketing/email-templates", read, async (_req, res) => {
  res.json(await prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }));
});

router.get("/marketing/email-templates/:id", read, async (req, res) => {
  const tpl = await prisma.emailTemplate.findUnique({ where: { id: param(req, "id") } });
  if (!tpl) throw notFound("Template not found");
  res.json({ ...tpl, variables: Object.keys(SAMPLE_EMAIL_VARS).concat(["storeName", "storeUrl"]) });
});

const templateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  subject: z.string().trim().min(2).max(200),
  html: z.string().min(1).max(100_000),
  isActive: z.boolean().default(true),
});

router.patch("/marketing/email-templates/:id", write, async (req, res) => {
  const body = parse(templateSchema.partial(), req.body);
  const tpl = await prisma.emailTemplate.update({ where: { id: param(req, "id") }, data: body });
  await logActivity(req, "email_template.update", "EmailTemplate", tpl.id, tpl.name);
  res.json(tpl);
});

router.post("/marketing/email-templates/preview", read, async (req, res) => {
  const body = parse(templateSchema.pick({ subject: true, html: true }), req.body);
  res.json(await renderEmail(body, SAMPLE_EMAIL_VARS));
});

router.post("/marketing/email-templates/:id/test", write, async (req, res) => {
  const { to } = parse(z.object({ to: z.string().email() }), req.body);
  const tpl = await prisma.emailTemplate.findUnique({ where: { id: param(req, "id") } });
  if (!tpl) throw notFound("Template not found");
  const { subject, html } = await renderEmail(tpl, SAMPLE_EMAIL_VARS);
  const info = await sendMail(to, `[Test] ${subject}`, html);
  if (!info) throw badRequest("Email could not be sent. Check SMTP settings.");
  res.json({ ok: true });
});

// ──────────────────────────────── Newsletter ─────────────────────────────────

router.get("/marketing/newsletter", read, async (req, res) => {
  const q = queryString(req, "q");
  const status = queryString(req, "status");
  const where: Prisma.NewsletterSubscriberWhereInput = {
    ...(status ? { status: status as SubscriberStatus } : {}),
    ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.newsletterSubscriber.findMany({ where, orderBy: { createdAt: "desc" } });
    await sendExport(res, format, "newsletter-subscribers", rows, [
      { key: "email", label: "Email", width: 30 },
      { key: "name", label: "Name" },
      { key: "status", label: "Status" },
      { key: "source", label: "Source" },
      { key: "createdAt", label: "Subscribed", value: (r) => r.createdAt.toISOString().slice(0, 10) },
    ]);
    return;
  }
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items, subscribed] = await Promise.all([
    prisma.newsletterSubscriber.count({ where }),
    prisma.newsletterSubscriber.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.newsletterSubscriber.count({ where: { status: "SUBSCRIBED" } }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), subscribed });
});

router.patch("/marketing/newsletter/:id", write, async (req, res) => {
  const body = parse(z.object({ status: z.enum(["SUBSCRIBED", "UNSUBSCRIBED"]) }), req.body);
  res.json(await prisma.newsletterSubscriber.update({ where: { id: param(req, "id") }, data: body }));
});

router.delete("/marketing/newsletter/:id", write, async (req, res) => {
  await prisma.newsletterSubscriber.delete({ where: { id: param(req, "id") } });
  res.json({ ok: true });
});

// ───────────────────────────── Abandoned carts ───────────────────────────────

router.get("/marketing/abandoned-carts", read, async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const { total, items } = await abandonedCarts({ idleMinutes: Number(queryString(req, "idle") ?? 60), skip, take });
  const value = items.reduce((s, c) => s + c.value, 0);
  res.json(serialize({ items, meta: pageMeta(total, page, limit), pageValue: round2(value) }));
});

router.post("/marketing/abandoned-carts/:id/remind", write, async (req, res) => {
  const ok = await sendCartReminder(param(req, "id"));
  if (!ok) throw badRequest("Reminder could not be sent (template disabled or cart empty)");
  await logActivity(req, "cart.remind", "Cart", param(req, "id"));
  res.json({ ok: true });
});

// ──────────────────────────────── Blog / lookbook ────────────────────────────

const postSchema = z.object({
  title: z.string().trim().min(3).max(200),
  slug: z.string().trim().max(200).optional(),
  type: z.enum(["BLOG", "LOOKBOOK"]).default("BLOG"),
  excerpt: z.string().max(500).optional().nullable(),
  content: richText(200_000).refine((v) => v.length > 0, "Content is required"),
  coverImage: z.string().optional().nullable(),
  author: z.string().max(80).default("Ananta Editorial"),
  tags: z.array(z.string()).default([]),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  seoTitle: z.string().max(200).optional().nullable(),
  seoDescription: z.string().max(400).optional().nullable(),
  publishedAt: optDate,
});

registerCrud(router, "/marketing/posts", {
  model: prisma.blogPost,
  area: "marketing",
  entity: "BlogPost",
  createSchema: postSchema,
  paginate: true,
  slugFrom: "title",
  orderBy: { createdAt: "desc" },
  searchFields: ["title", "excerpt"],
  listWhere: (req) => ({
    ...(queryString(req, "type") ? { type: queryString(req, "type") } : {}),
    ...(queryString(req, "status") ? { status: queryString(req, "status") } : {}),
  }),
  transform: async (data, _req, id) => {
    if (data.slug === "") data.slug = data.title ? slugify(data.title) : undefined;
    if (data.status === "PUBLISHED" && !data.publishedAt) {
      // Keep the original publish date when re-saving an already published post.
      const existing = id ? await prisma.blogPost.findUnique({ where: { id }, select: { publishedAt: true } }) : null;
      data.publishedAt = existing?.publishedAt ?? new Date();
    }
    return data;
  },
});

// ───────────────────────────────── Inquiries ─────────────────────────────────

router.get("/marketing/inquiries", read, async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const unread = queryString(req, "unread") === "1";
  const where = unread ? { isRead: false } : {};
  const [total, items, unreadCount] = await Promise.all([
    prisma.inquiry.count({ where }),
    prisma.inquiry.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.inquiry.count({ where: { isRead: false } }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), unread: unreadCount });
});

router.patch("/marketing/inquiries/:id", write, async (req, res) => {
  const body = parse(z.object({ isRead: z.boolean() }), req.body);
  res.json(await prisma.inquiry.update({ where: { id: param(req, "id") }, data: body }));
});

router.delete("/marketing/inquiries/:id", write, async (req, res) => {
  await prisma.inquiry.delete({ where: { id: param(req, "id") } });
  res.json({ ok: true });
});

export default router;
