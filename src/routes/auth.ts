import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { badRequest, parse, unauthorized } from "../lib/http";
import {
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
} from "../lib/auth";
import { requireCustomer } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimit";
import { getSetting } from "../lib/settings";
import { sendMail, sendTemplate } from "../lib/mailer";
import { randomToken, sha256 } from "../lib/utils";
import { env } from "../config/env";

const router = Router();

const customerSelect = {
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

function tokenFor(c: { id: string; name: string; email: string }) {
  return signAccessToken({ sub: c.id, typ: "customer", name: c.name, email: c.email });
}

/** Email a one-hour link to /account/reset-password (also used to activate guest-checkout accounts). */
async function sendPasswordLink(customer: { id: string; name: string; email: string }) {
  const raw = randomToken(32);
  await prisma.passwordReset.create({
    data: { customerId: customer.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  const link = `${env.STOREFRONT_URL}/account/reset-password?token=${raw}`;
  if (!env.SMTP_HOST && !env.isProd) console.log(`[mail:dev] password link for ${customer.email}: ${link}`);
  const sent = await sendTemplate("PASSWORD_RESET", customer.email, { customerName: customer.name, resetUrl: link });
  if (!sent) await sendMail(customer.email, "Set your password", `<p>Set your password: <a href="${link}">${link}</a></p>`);
}

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  password: z.string().min(8, "Password must be at least 8 characters").max(100),
  acceptsMarketing: z.boolean().optional(),
});

router.post("/register", authLimiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  const exists = await prisma.customer.findFirst({
    where: { OR: [{ email: body.email }, ...(body.phone ? [{ phone: body.phone }] : [])] },
  });
  if (exists) {
    // Guest checkout creates passwordless customers. Claiming one exposes its order history,
    // so ownership of the inbox is proven with a set-password link instead of signing in here.
    if (exists.email === body.email && !exists.passwordHash) {
      if (exists.isBlocked) throw unauthorized("This account has been suspended. Please contact support.");
      await sendPasswordLink(exists);
      res.status(202).json({
        verify: true,
        message: `You've shopped with us before as a guest. We've emailed a link to ${body.email} — use it to set your password and activate your account.`,
      });
      return;
    }
    throw badRequest("An account with this email or phone already exists");
  }
  const loyalty = await getSetting("loyalty");
  const customer = await prisma.customer.create({
    data: {
      name: body.name,
      email: body.email,
      phone: body.phone,
      passwordHash: await hashPassword(body.password),
      acceptsMarketing: body.acceptsMarketing ?? true,
      loyaltyPoints: loyalty.enabled ? loyalty.signupBonus : 0,
      loyaltyLedger:
        loyalty.enabled && loyalty.signupBonus
          ? { create: { type: "EARN", points: loyalty.signupBonus, note: "Welcome bonus" } }
          : undefined,
    },
    select: customerSelect,
  });
  await issueRefreshToken(req, res, "customer", customer.id);
  void sendTemplate("WELCOME", customer.email, { customerName: customer.name, points: customer.loyaltyPoints });
  res.status(201).json({ accessToken: tokenFor(customer), customer });
});

router.post("/login", authLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }), req.body);
  const row = await prisma.customer.findFirst({
    where: { OR: [{ email: body.email }, { phone: body.email }] },
  });
  if (!row?.passwordHash || !(await verifyPassword(body.password, row.passwordHash))) {
    throw unauthorized("Incorrect email or password");
  }
  if (row.isBlocked) throw unauthorized("This account has been suspended. Please contact support.");
  await prisma.customer.update({ where: { id: row.id }, data: { lastLoginAt: new Date() } });
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: row.id }, select: customerSelect });
  await issueRefreshToken(req, res, "customer", customer.id);
  res.json({ accessToken: tokenFor(customer), customer });
});

router.post("/refresh", async (req, res) => {
  const id = await rotateRefreshToken(req, res, "customer");
  const customer = await prisma.customer.findUnique({ where: { id }, select: { ...customerSelect, isBlocked: true } });
  if (!customer || customer.isBlocked) throw unauthorized();
  const { isBlocked: _b, ...safe } = customer;
  res.json({ accessToken: tokenFor(safe), customer: safe });
});

router.post("/logout", async (req, res) => {
  await revokeRefreshToken(req, res, "customer");
  res.json({ ok: true });
});

router.get("/me", requireCustomer, async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.customer!.sub }, select: customerSelect });
  if (!customer) throw unauthorized();
  res.json(customer);
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const customer = await prisma.customer.findUnique({ where: { email } });
  if (customer && !customer.isBlocked) await sendPasswordLink(customer);
  // Always succeed so emails can't be enumerated.
  res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), password: z.string().min(8).max(100) }), req.body);
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(body.token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest("This reset link is invalid or has expired");
  await prisma.$transaction([
    prisma.customer.update({ where: { id: row.customerId }, data: { passwordHash: await hashPassword(body.password) } }),
    prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Deleted rather than revoked so a stale device isn't treated as token theft (which would end the next login too).
    prisma.refreshToken.deleteMany({ where: { customerId: row.customerId } }),
  ]);
  res.json({ ok: true });
});

export default router;
