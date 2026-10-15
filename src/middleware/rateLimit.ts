import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { verifyAccessToken } from "../lib/auth";

const message = { message: "Too many requests, please slow down and try again shortly." };

/** Signed-in staff share office IPs with shoppers; their admin token already gates every admin route. */
function isAdminRequest(req: Request) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return false;
  try {
    return verifyAccessToken(h.slice(7).trim()).typ === "admin";
  } catch {
    return false;
  }
}

/** Global API limiter (per IP). */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: isAdminRequest,
  message,
});

/** Strict limiter for login / register / password reset. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts. Please wait a few minutes and try again." },
});

/** Checkout / order placement limiter. */
export const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message,
});
