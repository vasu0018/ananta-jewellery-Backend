import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AccessPayload } from "../lib/auth";
import { forbidden, unauthorized } from "../lib/http";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AccessPayload;
      customer?: AccessPayload;
    }
  }
}

function bearer(req: Request) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const payload = verifyAccessToken(token);
  if (payload.typ !== "admin") throw unauthorized("Admin session required");
  req.admin = payload;
  next();
}

export function hasPermission(perms: string[] | undefined, perm: string) {
  if (!perms) return false;
  if (perms.includes("*")) return true;
  if (perms.includes(perm)) return true;
  // "orders.write" implies "orders.read"
  const [area, action] = perm.split(".");
  return action === "read" && perms.includes(`${area}.write`);
}

/** Require at least one of the given permissions. */
export function requirePerm(...perms: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) throw unauthorized();
    if (!perms.some((p) => hasPermission(req.admin!.perms, p))) {
      throw forbidden(`Missing permission: ${perms.join(" or ")}`);
    }
    next();
  };
}

export function requireCustomer(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) throw unauthorized("Please sign in to continue");
  const payload = verifyAccessToken(token);
  if (payload.typ !== "customer") throw unauthorized();
  req.customer = payload;
  next();
}

/** Attach the customer if a valid token is present, but never fail. */
export function optionalCustomer(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      if (payload.typ === "customer") req.customer = payload;
    } catch {
      /* ignore expired tokens on public routes */
    }
  }
  next();
}
