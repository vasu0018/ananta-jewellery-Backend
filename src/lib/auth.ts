import type { CookieOptions, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { env } from "../config/env";
import { prisma } from "./prisma";
import { randomToken, sha256 } from "./utils";
import { clientIp, unauthorized } from "./http";

export type Principal = "admin" | "customer";

export type AccessPayload = {
  sub: string;
  typ: Principal;
  /** Admin role key + permissions are embedded so most requests need no DB lookup. */
  role?: string;
  perms?: string[];
  name?: string;
  email?: string;
};

export const REFRESH_COOKIE: Record<Principal, string> = {
  admin: "aj_admin_rt",
  customer: "aj_rt",
};

const REFRESH_PATH: Record<Principal, string> = {
  admin: "/api/v1/admin/auth",
  customer: "/api/v1/auth",
};

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload: AccessPayload) {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  } catch {
    throw unauthorized("Session expired, please sign in again");
  }
}

function cookieOptions(typ: Principal, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SECURE ? "none" : "lax",
    domain: env.COOKIE_DOMAIN || undefined,
    path: REFRESH_PATH[typ],
    maxAge: maxAgeMs,
  };
}

/** Creates a new refresh token row and sets it as an httpOnly cookie. */
export async function issueRefreshToken(
  req: Request,
  res: Response,
  typ: Principal,
  ownerId: string,
) {
  const raw = randomToken(48);
  const maxAge = env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  await prisma.refreshToken.create({
    data: {
      tokenHash: sha256(raw),
      adminId: typ === "admin" ? ownerId : undefined,
      customerId: typ === "customer" ? ownerId : undefined,
      userAgent: req.headers["user-agent"]?.slice(0, 250),
      ip: clientIp(req),
      expiresAt: new Date(Date.now() + maxAge),
    },
  });
  res.cookie(REFRESH_COOKIE[typ], raw, cookieOptions(typ, maxAge));
  return raw;
}

/**
 * Validates + rotates the refresh token from cookie (or body for native clients).
 * Re-use of a revoked token revokes the whole family for that owner.
 */
export async function rotateRefreshToken(req: Request, res: Response, typ: Principal) {
  const raw: string | undefined =
    req.cookies?.[REFRESH_COOKIE[typ]] || (req.body && req.body.refreshToken);
  if (!raw) throw unauthorized("No refresh token");
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
  const ownerId = typ === "admin" ? row?.adminId : row?.customerId;
  if (!row || !ownerId) throw unauthorized("Invalid refresh token");
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: typ === "admin" ? { adminId: ownerId } : { customerId: ownerId },
      data: { revokedAt: new Date() },
    });
    throw unauthorized("Refresh token reuse detected");
  }
  if (row.expiresAt < new Date()) throw unauthorized("Refresh token expired");
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  await issueRefreshToken(req, res, typ, ownerId);
  return ownerId;
}

export async function revokeRefreshToken(req: Request, res: Response, typ: Principal) {
  const raw: string | undefined = req.cookies?.[REFRESH_COOKIE[typ]];
  if (raw) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie(REFRESH_COOKIE[typ], { ...cookieOptions(typ, 0), maxAge: undefined });
}
