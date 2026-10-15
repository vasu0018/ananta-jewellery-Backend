import { Router } from "express";
import multer from "multer";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, forbidden, HttpError, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { hashPassword } from "../../lib/auth";
import { PERMISSIONS } from "../../lib/permissions";
import { getRazorpayConfig, getSetting, maskSecret, setSetting, SETTING_DEFAULTS, type SettingKey } from "../../lib/settings";
import { storage, storeUpload } from "../../lib/storage";
import { SAMPLE_EMAIL_VARS, sendMail } from "../../lib/mailer";
import { MESSAGE_EVENTS, sendSms, sendWhatsapp, type MessageEvent } from "../../lib/messaging";
import { sendExport } from "../../lib/export";
import { env } from "../../config/env";

const router = Router();

// ──────────────────────────────── Settings ───────────────────────────────────

const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

/** Secret paths per settings key: masked on read, ignored on write when still masked. */
const SECRET_PATHS: Partial<Record<SettingKey, string[][]>> = {
  payments: [["razorpay", "keySecret"], ["razorpay", "webhookSecret"]],
  notifications: [["sms", "apiKey"], ["whatsapp", "accessToken"]],
};

function getPath(obj: Record<string, unknown>, path: string[]) {
  return path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown) {
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") return;
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

function deletePath(obj: Record<string, unknown>, path: string[]) {
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") return;
    cur = cur[k] as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]];
}

async function maskedSetting(key: SettingKey) {
  const value = structuredClone(await getSetting(key)) as Record<string, unknown>;
  for (const p of SECRET_PATHS[key] ?? []) setPath(value, p, maskSecret(getPath(value, p) as string));
  return value;
}

router.get("/settings", requirePerm("settings.read"), async (_req, res) => {
  const entries = await Promise.all(SETTING_KEYS.map(async (k) => [k, await maskedSetting(k)] as const));
  const rzp = await getRazorpayConfig();
  res.json({
    ...Object.fromEntries(entries),
    meta: {
      razorpayMock: rzp.mock,
      razorpayWebhookUrl: `${env.API_PUBLIC_URL}/api/v1/webhooks/razorpay`,
      shippingWebhookUrl: `${env.API_PUBLIC_URL}/api/v1/webhooks/shipping/{PARTNER_CODE}?token=...`,
      smtpConfigured: !!env.SMTP_HOST,
      storageDriver: env.STORAGE_DRIVER,
      messageEvents: Object.entries(MESSAGE_EVENTS).map(([key, e]) => ({ key, label: e.label, params: e.params })),
    },
  });
});

router.post("/settings/test-email", requirePerm("settings.write"), async (req, res) => {
  const { to } = parse(z.object({ to: z.string().email() }), req.body);
  const store = await getSetting("store");
  const info = await sendMail(to, `[Test] ${store.name} email settings`, `<p>This is a test email from the ${store.name} admin panel. Your email settings work.</p>`);
  if (!info) throw badRequest("Email could not be sent. Check the SMTP settings on the server.");
  res.json({ ok: true, delivered: !!env.SMTP_HOST });
});

router.post("/settings/test-message", requirePerm("settings.write"), async (req, res) => {
  const body = parse(
    z.object({
      channel: z.enum(["sms", "whatsapp"]),
      event: z.enum(Object.keys(MESSAGE_EVENTS) as [MessageEvent, ...MessageEvent[]]),
      to: z.string().trim().min(10).max(20),
    }),
    req.body,
  );
  const vars = { ...SAMPLE_EMAIL_VARS };
  try {
    const sent = body.channel === "sms" ? await sendSms(body.event, body.to, vars, { templateId: await smsTemplate(body.event) }) : await sendWhatsapp(body.event, body.to, vars, { templateName: await waTemplate(body.event) });
    if (!sent) throw badRequest(body.channel === "sms" ? "Add the MSG91 auth key first." : "Add the WhatsApp phone number ID and access token first.");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest(`Provider rejected the message: ${e instanceof Error ? e.message : String(e)}`);
  }
  res.json({ ok: true });
});

async function smsTemplate(event: MessageEvent) {
  const id = (await getSetting("notifications")).sms.templateIds[event];
  if (!id) throw badRequest("Set a MSG91 template id for this event first.");
  return id;
}

async function waTemplate(event: MessageEvent) {
  const name = (await getSetting("notifications")).whatsapp.templates[event];
  if (!name) throw badRequest("Set a WhatsApp template name for this event first.");
  return name;
}

router.get("/settings/:key", requirePerm("settings.read"), async (req, res) => {
  const key = param(req, "key") as SettingKey;
  if (!SETTING_KEYS.includes(key)) throw notFound("Unknown settings group");
  res.json(await maskedSetting(key));
});

router.put("/settings/:key", requirePerm("settings.write"), async (req, res) => {
  const key = param(req, "key") as SettingKey;
  if (!SETTING_KEYS.includes(key)) throw notFound("Unknown settings group");
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw badRequest("Settings must be an object");
  const patch = structuredClone(req.body) as Record<string, unknown>;
  for (const p of SECRET_PATHS[key] ?? []) {
    const v = getPath(patch, p);
    if (typeof v === "string" && v.includes("••••")) deletePath(patch, p);
  }
  if (key === "payments" && req.admin!.role !== "ADMIN" && !req.admin!.perms?.includes("*")) {
    throw forbidden("Only admins can change payment settings");
  }
  await setSetting(key, patch);
  await logActivity(req, "settings.update", "Setting", key, `Updated ${key} settings`);
  res.json(await maskedSetting(key));
});

// ─────────────────────────────── Admin users ─────────────────────────────────

const manageUsers = requirePerm("users.manage");
const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatarUrl: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { id: true, key: true, name: true } },
} satisfies Prisma.AdminUserSelect;

router.get("/users", manageUsers, async (_req, res) => {
  res.json(await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" }, select: userSelect }));
});

const userSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().max(20).optional().nullable(),
  roleId: z.string(),
  isActive: z.boolean().default(true),
  password: z.string().min(8, "Password must be at least 8 characters").max(100).optional(),
});

router.post("/users", manageUsers, async (req, res) => {
  const body = parse(userSchema.required({ password: true }), req.body);
  const { password, ...data } = body;
  const user = await prisma.adminUser.create({ data: { ...data, passwordHash: await hashPassword(password) }, select: userSelect });
  await logActivity(req, "user.create", "AdminUser", user.id, `${user.name} (${user.role.name})`);
  res.status(201).json(user);
});

async function assertNotLastAdmin(userId: string) {
  const user = await prisma.adminUser.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw notFound("User not found");
  if (user.role.key === "ADMIN") {
    const admins = await prisma.adminUser.count({ where: { isActive: true, role: { key: "ADMIN" } } });
    if (admins <= 1) throw badRequest("At least one active admin is required");
  }
  return user;
}

router.patch("/users/:id", manageUsers, async (req, res) => {
  const id = param(req, "id");
  const body = parse(userSchema.partial(), req.body);
  if (id === req.admin!.sub && (body.isActive === false || body.roleId)) throw badRequest("You cannot change your own role or disable yourself");
  if (body.isActive === false) await assertNotLastAdmin(id);
  if (body.roleId) {
    const [current, target] = await Promise.all([
      prisma.adminUser.findUnique({ where: { id }, include: { role: true } }),
      prisma.role.findUnique({ where: { id: body.roleId } }),
    ]);
    if (!target) throw badRequest("Role not found");
    if (current?.role.key === "ADMIN" && target.key !== "ADMIN") await assertNotLastAdmin(id);
  }
  const { password, ...data } = body;
  const user = await prisma.adminUser.update({
    where: { id },
    data: { ...data, ...(password ? { passwordHash: await hashPassword(password) } : {}) },
    select: userSelect,
  });
  if (body.isActive === false || password) {
    await prisma.refreshToken.deleteMany({ where: { adminId: id } });
  }
  await logActivity(req, "user.update", "AdminUser", id, user.name);
  res.json(user);
});

router.delete("/users/:id", manageUsers, async (req, res) => {
  const id = param(req, "id");
  if (id === req.admin!.sub) throw badRequest("You cannot delete your own account");
  const user = await assertNotLastAdmin(id);
  await prisma.adminUser.delete({ where: { id } });
  await logActivity(req, "user.delete", "AdminUser", id, user.name);
  res.json({ ok: true });
});

// ─────────────────────────────────── Roles ───────────────────────────────────

router.get("/permissions", requirePerm("users.manage", "settings.read"), (_req, res) => {
  res.json(PERMISSIONS);
});

router.get("/roles", manageUsers, async (_req, res) => {
  res.json(await prisma.role.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { admins: true } } } }));
});

const validPerms = new Set<string>(["*", ...PERMISSIONS.map((p) => p.key)]);
const roleSchema = z.object({
  name: z.string().trim().min(2).max(40),
  key: z.string().trim().min(2).max(30).regex(/^[A-Za-z_]+$/).optional(),
  description: z.string().max(200).optional().nullable(),
  permissions: z.array(z.string().refine((p) => validPerms.has(p), "Unknown permission")).min(1),
});

router.post("/roles", manageUsers, async (req, res) => {
  const body = parse(roleSchema, req.body);
  const role = await prisma.role.create({
    data: { ...body, key: (body.key ?? body.name).toUpperCase().replace(/[^A-Z_]/g, "_") },
  });
  await logActivity(req, "role.create", "Role", role.id, role.name);
  res.status(201).json(role);
});

router.patch("/roles/:id", manageUsers, async (req, res) => {
  const id = param(req, "id");
  const body = parse(roleSchema.partial().omit({ key: true }), req.body);
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw notFound("Role not found");
  if (role.key === "ADMIN" && body.permissions) throw badRequest("The Admin role always has full access");
  const updated = await prisma.role.update({ where: { id }, data: body });
  await logActivity(req, "role.update", "Role", id, updated.name);
  res.json(updated);
});

router.delete("/roles/:id", manageUsers, async (req, res) => {
  const id = param(req, "id");
  const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { admins: true } } } });
  if (!role) throw notFound("Role not found");
  if (role.isSystem) throw badRequest("System roles cannot be deleted");
  if (role._count.admins) throw badRequest("Reassign users from this role first");
  await prisma.role.delete({ where: { id } });
  await logActivity(req, "role.delete", "Role", id, role.name);
  res.json({ ok: true });
});

// ─────────────────────────────── Activity logs ───────────────────────────────

router.get("/activity-logs", requirePerm("logs.read"), async (req, res) => {
  const q = queryString(req, "q");
  const from = queryString(req, "from");
  const to = queryString(req, "to");
  const where: Prisma.ActivityLogWhereInput = {
    ...(queryString(req, "adminId") ? { adminId: queryString(req, "adminId") } : {}),
    ...(queryString(req, "entity") ? { entity: queryString(req, "entity") } : {}),
    ...(queryString(req, "entityId") ? { entityId: queryString(req, "entityId") } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: new Date(`${from}T00:00:00+05:30`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999+05:30`) } : {}) } } : {}),
    ...(q ? { OR: [{ action: { contains: q, mode: "insensitive" } }, { summary: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const include = { admin: { select: { id: true, name: true, email: true } } } satisfies Prisma.ActivityLogInclude;
  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.activityLog.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 20000 });
    await sendExport(res, format, "activity-log", rows, [
      { key: "createdAt", label: "Time", value: (r) => r.createdAt.toISOString().replace("T", " ").slice(0, 19) },
      { key: "admin", label: "User", value: (r) => r.admin?.name ?? "System" },
      { key: "action", label: "Action" },
      { key: "entity", label: "Entity" },
      { key: "summary", label: "Summary", width: 40 },
      { key: "ip", label: "IP" },
    ]);
    return;
  }
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items, entities] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.activityLog.findMany({ distinct: ["entity"], select: { entity: true }, orderBy: { entity: "asc" } }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), entities: entities.map((e) => e.entity) });
});

// ─────────────────────────────────── Media ───────────────────────────────────

const mediaRead = requirePerm("media.write", "products.write", "marketing.write");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|avif|gif|svg\+xml)$/.test(file.mimetype) || file.mimetype === "application/pdf";
    if (ok) cb(null, true);
    else cb(badRequest(`Unsupported file type: ${file.mimetype}`));
  },
});

router.get("/media", mediaRead, async (req, res) => {
  const q = queryString(req, "q");
  const folder = queryString(req, "folder");
  const where: Prisma.MediaWhereInput = {
    ...(folder ? { folder } : {}),
    ...(q ? { OR: [{ filename: { contains: q, mode: "insensitive" } }, { alt: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items, folders] = await Promise.all([
    prisma.media.count({ where }),
    prisma.media.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.media.groupBy({ by: ["folder"], _count: { _all: true }, orderBy: { folder: "asc" } }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), folders: folders.map((f) => ({ name: f.folder, count: f._count._all })) });
});

router.post("/media", mediaRead, upload.array("files", 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest("No files uploaded");
  const folder = (typeof req.body.folder === "string" && req.body.folder.trim()) || "general";
  const safeFolder = folder.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "general";
  const created = [];
  for (const f of files) {
    const stored = await storeUpload(f, safeFolder);
    created.push(await prisma.media.create({ data: { ...stored, folder: safeFolder, alt: req.body.alt || null } }));
  }
  await logActivity(req, "media.upload", "Media", null, `${created.length} file(s) to ${safeFolder}`);
  res.status(201).json(created);
});

/** Where a file is referenced, so staff know what breaks before deleting it. */
router.get("/media/:id/usage", mediaRead, async (req, res) => {
  const m = await prisma.media.findUnique({ where: { id: param(req, "id") } });
  if (!m) throw notFound("File not found");
  const url = m.url;
  const [products, categories, collections, banners, flashSales, posts] = await Promise.all([
    prisma.productImage.findMany({ where: { url }, select: { product: { select: { id: true, name: true } } }, take: 20 }),
    prisma.category.findMany({ where: { OR: [{ image: url }, { bannerImage: url }] }, select: { id: true, name: true }, take: 20 }),
    prisma.collection.findMany({ where: { OR: [{ image: url }, { bannerImage: url }] }, select: { id: true, name: true }, take: 20 }),
    prisma.banner.findMany({ where: { OR: [{ image: url }, { mobileImage: url }] }, select: { id: true, title: true }, take: 20 }),
    prisma.flashSale.findMany({ where: { bannerImage: url }, select: { id: true, name: true }, take: 20 }),
    prisma.blogPost.findMany({ where: { coverImage: url }, select: { id: true, title: true }, take: 20 }),
  ]);
  const seen = new Set<string>();
  res.json([
    ...products.filter((p) => !seen.has(p.product.id) && seen.add(p.product.id)).map((p) => ({ type: "Product", id: p.product.id, label: p.product.name })),
    ...categories.map((c) => ({ type: "Category", id: c.id, label: c.name })),
    ...collections.map((c) => ({ type: "Collection", id: c.id, label: c.name })),
    ...banners.map((b) => ({ type: "Banner", id: b.id, label: b.title })),
    ...flashSales.map((f) => ({ type: "FlashSale", id: f.id, label: f.name })),
    ...posts.map((p) => ({ type: "BlogPost", id: p.id, label: p.title })),
  ]);
});

router.patch("/media/:id", mediaRead, async (req, res) => {
  const body = parse(z.object({ alt: z.string().max(200).optional().nullable(), folder: z.string().max(40).optional() }), req.body);
  if (body.folder !== undefined) body.folder = body.folder.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "general";
  res.json(await prisma.media.update({ where: { id: param(req, "id") }, data: body }));
});

router.delete("/media/:id", requirePerm("media.write"), async (req, res) => {
  const m = await prisma.media.findUnique({ where: { id: param(req, "id") } });
  if (!m) throw notFound("File not found");
  await storage.remove(m.url).catch(() => undefined);
  await prisma.media.delete({ where: { id: m.id } });
  await logActivity(req, "media.delete", "Media", m.id, m.filename);
  res.json({ ok: true });
});

export default router;
