import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import multer from "multer";
import { HttpError } from "../lib/http";
import { env } from "../config/env";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      details: err.issues,
    });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = (err.meta?.target as string[] | undefined)?.join(", ") || "field";
      res.status(409).json({ message: `A record with this ${target} already exists` });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ message: "Record not found" });
      return;
    }
    if (err.code === "P2003") {
      res.status(409).json({ message: "This record is referenced by other data and cannot be changed" });
      return;
    }
  }
  if (err instanceof multer.MulterError) {
    res.status(400).json({ message: err.message });
    return;
  }
  if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed") {
    res.status(400).json({ message: "Invalid JSON body" });
    return;
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    message: "Something went wrong. Please try again.",
    ...(env.isProd ? {} : { error: err instanceof Error ? err.message : String(err) }),
  });
}
