import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { storage, storeUpload } from "../../lib/storage";
import { prisma } from "../../lib/prisma";
import { badRequest, parse, unauthorized } from "../../lib/http";
import {
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
} from "../../lib/auth";
import { requireAdmin } from "../../middleware/auth";
import { authLimiter } from "../../middleware/rateLimit";
import { logActivity } from "../../lib/audit";

const router = Router();

async function loadAdmin(id: string) {
  const admin = await prisma.adminUser.findUnique({ where: { id }, include: { role: true } });
  if (!admin || !admin.isActive) throw unauthorized("Account disabled");
  return admin;
}

function present(admin: Awaited<ReturnType<typeof loadAdmin>>) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    phone: admin.phone,
    avatarUrl: admin.avatarUrl,
    role: admin.role.key,
    roleName: admin.role.name,
    permissions: admin.role.permissions,
  };
}

function tokenFor(admin: Awaited<ReturnType<typeof loadAdmin>>) {
  return signAccessToken({
    sub: admin.id,
    typ: "admin",
    role: admin.role.key,
    perms: admin.role.permissions,
    name: admin.name,
    email: admin.email,
  });
}

router.post("/login", authLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
  const row = await prisma.adminUser.findUnique({ where: { email: body.email }, include: { role: true } });
  if (!row || !(await verifyPassword(body.password, row.passwordHash))) throw unauthorized("Invalid email or password");
  if (!row.isActive) throw unauthorized("Your account has been disabled");
  await prisma.adminUser.update({ where: { id: row.id }, data: { lastLoginAt: new Date() } });
  await issueRefreshToken(req, res, "admin", row.id);
  req.admin = { sub: row.id, typ: "admin" };
  await logActivity(req, "auth.login", "AdminUser", row.id, `${row.name} signed in`);
  res.json({ accessToken: tokenFor(row), user: present(row) });
});

router.post("/refresh", async (req, res) => {
  const id = await rotateRefreshToken(req, res, "admin");
  const admin = await loadAdmin(id);
  res.json({ accessToken: tokenFor(admin), user: present(admin) });
});

router.post("/logout", async (req, res) => {
  await revokeRefreshToken(req, res, "admin");
  res.json({ ok: true });
});

router.get("/me", requireAdmin, async (req, res) => {
  res.json(present(await loadAdmin(req.admin!.sub)));
});

router.patch("/me", requireAdmin, async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80).optional(),
      phone: z.string().max(20).optional().nullable(),
      // Photos are set via POST /me/avatar; here they can only be removed.
      avatarUrl: z.null().optional(),
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8).max(100).optional(),
    }),
    req.body,
  );
  const admin = await loadAdmin(req.admin!.sub);
  const data: Record<string, unknown> = { name: body.name, phone: body.phone, avatarUrl: body.avatarUrl };
  if (body.newPassword) {
    // 400, not 401: a 401 makes the client treat the session as expired and sign out.
    if (!(await verifyPassword(body.currentPassword ?? "", admin.passwordHash))) throw badRequest("Current password is incorrect");
    data.passwordHash = await hashPassword(body.newPassword);
  }
  const updated = await prisma.adminUser.update({ where: { id: admin.id }, data, include: { role: true } });
  if (body.newPassword) {
    // Sign out every other session; this browser gets a fresh refresh token. Rows are deleted
    // (not marked revoked) so old devices aren't mistaken for token theft, which would kill this session too.
    await prisma.refreshToken.deleteMany({ where: { adminId: admin.id } });
    await issueRefreshToken(req, res, "admin", admin.id);
  }
  if (body.avatarUrl === null && admin.avatarUrl?.includes("/avatars/")) await storage.remove(admin.avatarUrl).catch(() => undefined);
  await logActivity(req, "auth.profile", "AdminUser", admin.id, body.newPassword ? "Changed password" : "Updated profile");
  res.json(present(updated));
});

/** Self-service profile photo — needs no media permission, unlike the media library. */
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|avif)$/.test(file.mimetype)) cb(null, true);
    else cb(badRequest("Use a JPG, PNG, WebP or AVIF image"));
  },
});

router.post("/me/avatar", requireAdmin, avatarUpload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("No image uploaded");
  const admin = await loadAdmin(req.admin!.sub);
  const stored = await storeUpload(req.file, "avatars");
  const updated = await prisma.adminUser.update({ where: { id: admin.id }, data: { avatarUrl: stored.url }, include: { role: true } });
  if (admin.avatarUrl?.includes("/avatars/")) await storage.remove(admin.avatarUrl).catch(() => undefined);
  res.json(present(updated));
});

export default router;
