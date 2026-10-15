import type { Request } from "express";
import { z, type ZodTypeAny } from "zod";

/** Error carrying an HTTP status code; rendered by the global error handler. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg = "Bad request", details?: unknown) =>
  new HttpError(400, msg, details);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg = "Conflict") => new HttpError(409, msg);

/** Parse & validate input with a zod schema (throws a 400 on failure). */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    throw badRequest(
      fields.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join(", "),
      fields,
    );
  }
  return result.data;
}

/** Standard pagination query (?page=1&limit=20). */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

export function pageArgs(query: Request["query"]) {
  const { page, limit } = parse(paginationSchema, query);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function pageMeta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : String(v);
}

export function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined || v === null || v === "") return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

/** Repeated and/or delimited query values. Pass `"|"` for free-text values that may contain commas. */
export function queryList(req: Request, name: string, separator: string | RegExp = ","): string[] {
  const v = req.query[name];
  if (v === undefined || v === "") return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => String(x).split(separator))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function clientIp(req: Request) {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    undefined
  );
}
