import crypto from "crypto";
import { Prisma } from "@prisma/client";

export function slugify(input: string) {
  return input
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomDigits(len: number) {
  let out = "";
  for (let i = 0; i < len; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

/** Decimal / number / string → number rounded to 2 decimals. */
export function num(v: Prisma.Decimal | number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v.toString());
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function formatInr(n: number) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** Recursively converts Prisma.Decimal values to plain numbers for JSON responses. */
export function serialize<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Prisma.Decimal.isDecimal(value)) return num(value as unknown as Prisma.Decimal) as unknown as T;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => serialize(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v);
    }
    return out as T;
  }
  return value;
}

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

/** Resolve "today" | "7d" | "30d" | "90d" | "1y" | "custom" into a date window. */
export function resolveRange(range?: string, from?: string, to?: string) {
  const now = new Date();
  const end = to ? new Date(`${to}T23:59:59.999`) : now;
  let start: Date;
  switch (range) {
    case "today":
      start = startOfDay(now);
      break;
    case "7d":
      start = startOfDay(addDays(now, -6));
      break;
    case "90d":
      start = startOfDay(addDays(now, -89));
      break;
    case "1y":
      start = startOfDay(addDays(now, -364));
      break;
    case "custom":
      start = from ? new Date(`${from}T00:00:00`) : startOfDay(addDays(now, -29));
      break;
    case "30d":
    default:
      start = startOfDay(addDays(now, -29));
  }
  const span = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - span);
  return { start, end, prevStart, prevEnd: start };
}

export function pctChange(curr: number, prev: number) {
  if (!prev) return curr ? 100 : 0;
  return round2(((curr - prev) / Math.abs(prev)) * 100);
}

export function renderTemplate(tpl: string, vars: Record<string, unknown>) {
  return tpl.replace(/{{\s*([\w.]+)\s*}}/g, (_, key: string) => {
    const val = key.split(".").reduce<unknown>((acc, k) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
      return undefined;
    }, vars);
    return val === undefined || val === null ? "" : String(val);
  });
}
