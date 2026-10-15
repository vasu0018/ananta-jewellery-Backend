import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { apiLimiter } from "./middleware/rateLimit";
import { errorHandler, notFoundHandler } from "./middleware/error";
import authRoutes from "./routes/auth";
import catalogRoutes from "./routes/catalog";
import storeRoutes from "./routes/store";
import checkoutRoutes, { razorpayWebhook } from "./routes/checkout";
import contentRoutes from "./routes/content";
import adminRoutes from "./routes/admin";
import { shippingWebhook } from "./routes/admin/shipping";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      // Images in /uploads are embedded by the storefront & admin on other origins.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  if (!env.isProd || process.env.LOG_REQUESTS === "1") app.use(morgan(env.isProd ? "combined" : "dev"));

  // Webhooks need the raw body for signature verification — register before express.json().
  app.post("/api/v1/webhooks/razorpay", express.raw({ type: "*/*", limit: "1mb" }), razorpayWebhook);
  app.post("/api/v1/webhooks/shipping/:code", express.json({ limit: "1mb" }), shippingWebhook);

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  app.use(
    "/uploads",
    express.static(path.resolve(process.cwd(), env.UPLOAD_DIR), { maxAge: "30d", immutable: true, fallthrough: false }),
  );

  app.get("/api/v1/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api/v1", apiLimiter);
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/catalog", catalogRoutes);
  app.use("/api/v1/checkout", checkoutRoutes);
  app.use("/api/v1/admin", adminRoutes);
  app.use("/api/v1", contentRoutes);
  // Customer-only routes (requireCustomer applied inside) go last so public routes match first.
  app.use("/api/v1", storeRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
