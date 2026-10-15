import { Router } from "express";
import multer from "multer";
import type { Prisma, StockMovementReason, TransferStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { registerCrud } from "../../lib/crud";
import { adjustStock, defaultWarehouseId, lowStockVariants } from "../../lib/inventory";
import { parseCsv, sendExport } from "../../lib/export";
import { randomDigits, serialize } from "../../lib/utils";

const router = Router();
const read = requirePerm("inventory.read");
const write = requirePerm("inventory.write");

const REASONS = ["ADJUSTMENT", "RESTOCK", "SALE", "RETURN", "CANCELLATION", "DAMAGE", "TRANSFER_IN", "TRANSFER_OUT"] as const;
const MANUAL_REASONS = ["ADJUSTMENT", "RESTOCK", "RETURN", "DAMAGE"] as const;

// ──────────────────────────────── Stock grid ─────────────────────────────────

router.get("/inventory", read, async (req, res) => {
  const q = queryString(req, "q");
  const stock = queryString(req, "stock");
  const warehouseId = queryString(req, "warehouseId");
  const where: Prisma.ProductVariantWhereInput = {
    product: { status: { not: "ARCHIVED" }, ...(queryString(req, "categoryId") ? { categoryId: queryString(req, "categoryId") } : {}) },
    ...(q
      ? {
          OR: [
            { sku: { contains: q, mode: "insensitive" } },
            { barcode: { contains: q, mode: "insensitive" } },
            { title: { contains: q, mode: "insensitive" } },
            { product: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [warehouses, variants] = await Promise.all([
    prisma.warehouse.findMany({ where: { isActive: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    prisma.productVariant.findMany({
      where,
      orderBy: [{ product: { name: "asc" } }, { sortOrder: "asc" }],
      select: {
        id: true,
        sku: true,
        title: true,
        isActive: true,
        product: { select: { id: true, name: true, status: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } },
        inventory: { select: { warehouseId: true, quantity: true, reserved: true, lowStockThreshold: true, updatedAt: true } },
      },
    }),
  ]);
  let rows = variants.map((v) => {
    const levels = warehouseId ? v.inventory.filter((l) => l.warehouseId === warehouseId) : v.inventory;
    const onHand = levels.reduce((s, l) => s + l.quantity, 0);
    const reserved = levels.reduce((s, l) => s + l.reserved, 0);
    const threshold = levels.length ? Math.max(...levels.map((l) => l.lowStockThreshold)) : 5;
    const available = onHand - reserved;
    return {
      variantId: v.id,
      productId: v.product.id,
      name: v.product.name,
      productStatus: v.product.status,
      variantTitle: v.title,
      sku: v.sku,
      image: v.product.images[0]?.url ?? null,
      isActive: v.isActive,
      byWarehouse: Object.fromEntries(v.inventory.map((l) => [l.warehouseId, { quantity: l.quantity, reserved: l.reserved, threshold: l.lowStockThreshold }])),
      onHand,
      reserved,
      available,
      threshold,
      state: available <= 0 ? "OUT" : available <= threshold ? "LOW" : "IN",
    };
  });
  if (stock === "out") rows = rows.filter((r) => r.state === "OUT");
  if (stock === "low") rows = rows.filter((r) => r.state === "LOW");
  if (stock === "in") rows = rows.filter((r) => r.state === "IN");

  const format = queryString(req, "format");
  if (format) {
    await sendExport(res, format, "inventory", rows, [
      { key: "sku", label: "sku" },
      { key: "name", label: "product" },
      { key: "variantTitle", label: "variant" },
      ...warehouses.map((w) => ({ key: `wh_${w.code}`, label: w.code, value: (r: (typeof rows)[number]) => r.byWarehouse[w.id]?.quantity ?? 0 })),
      { key: "reserved", label: "reserved" },
      { key: "available", label: "available" },
      { key: "threshold", label: "threshold" },
    ]);
    return;
  }

  const { page, limit, skip, take } = pageArgs(req.query);
  const summary = {
    skus: rows.length,
    units: rows.reduce((s, r) => s + r.onHand, 0),
    low: rows.filter((r) => r.state === "LOW").length,
    out: rows.filter((r) => r.state === "OUT").length,
  };
  res.json({
    warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code, isDefault: w.isDefault })),
    items: rows.slice(skip, skip + take),
    meta: pageMeta(rows.length, page, limit),
    summary,
  });
});

router.get("/inventory/low-stock", read, async (_req, res) => {
  res.json(await lowStockVariants(500));
});

const adjustSchema = z
  .object({
    variantId: z.string(),
    warehouseId: z.string().optional(),
    change: z.number().int().optional(),
    set: z.number().int().min(0).optional(),
    reason: z.enum(MANUAL_REASONS).default("ADJUSTMENT"),
    note: z.string().max(300).optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
  })
  .refine((b) => b.change !== undefined || b.set !== undefined || b.lowStockThreshold !== undefined, { message: "Provide change, set or lowStockThreshold" });

router.post("/inventory/adjust", write, async (req, res) => {
  const body = parse(adjustSchema, req.body);
  const warehouseId = body.warehouseId ?? (await defaultWarehouseId());
  const level = await prisma.$transaction(async (tx) => {
    let lvl = await adjustStock(tx, { ...body, warehouseId, actor: req.admin!.name });
    if (body.lowStockThreshold !== undefined) {
      lvl = await tx.inventoryLevel.update({ where: { id: lvl.id }, data: { lowStockThreshold: body.lowStockThreshold } });
    }
    return lvl;
  });
  await logActivity(req, "inventory.adjust", "ProductVariant", body.variantId, body.set !== undefined ? `Set to ${body.set}` : body.change !== undefined ? `${body.change > 0 ? "+" : ""}${body.change}` : `Threshold ${body.lowStockThreshold}`, { reason: body.reason, note: body.note });
  res.json(level);
});

const bulkSchema = z.object({
  reason: z.enum(MANUAL_REASONS).default("ADJUSTMENT"),
  note: z.string().max(300).optional(),
  items: z
    .array(
      z.object({
        variantId: z.string().optional(),
        sku: z.string().optional(),
        warehouseId: z.string().optional(),
        set: z.number().int().min(0).optional(),
        change: z.number().int().optional(),
        lowStockThreshold: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

async function applyBulk(input: z.infer<typeof bulkSchema>, actor: string) {
  const defaultWh = await defaultWarehouseId();
  const skus = input.items.filter((i) => !i.variantId && i.sku).map((i) => i.sku!);
  const bySku = new Map((await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } })).map((v) => [v.sku, v.id]));
  const result = { updated: 0, errors: [] as { ref: string; error: string }[] };
  for (const item of input.items) {
    const variantId = item.variantId ?? (item.sku ? bySku.get(item.sku) : undefined);
    const ref = item.sku ?? item.variantId ?? "?";
    if (!variantId) {
      result.errors.push({ ref, error: "Unknown SKU" });
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const lvl = await adjustStock(tx, { variantId, warehouseId: item.warehouseId ?? defaultWh, set: item.set, change: item.change, reason: input.reason, note: input.note, actor });
        if (item.lowStockThreshold !== undefined) await tx.inventoryLevel.update({ where: { id: lvl.id }, data: { lowStockThreshold: item.lowStockThreshold } });
      });
      result.updated++;
    } catch (e) {
      result.errors.push({ ref, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

router.post("/inventory/bulk", write, async (req, res) => {
  const body = parse(bulkSchema, req.body);
  const result = await applyBulk(body, req.admin!.name ?? "admin");
  await logActivity(req, "inventory.bulk", "Inventory", null, `${result.updated} SKUs updated`);
  res.json(result);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** CSV columns: sku, warehouse (code, optional), quantity, threshold (optional) */
router.post("/inventory/import", write, upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("Upload a CSV file");
  const rows = parseCsv(req.file.buffer.toString("utf8"));
  const warehouses = await prisma.warehouse.findMany({ select: { id: true, code: true } });
  const items = rows
    .filter((r) => r.sku)
    .map((r) => ({
      sku: r.sku.trim(),
      warehouseId: r.warehouse ? warehouses.find((w) => w.code.toLowerCase() === r.warehouse.trim().toLowerCase())?.id : undefined,
      set: r.quantity !== undefined && r.quantity !== "" ? Math.max(0, Math.floor(Number(r.quantity))) : undefined,
      lowStockThreshold: r.threshold ? Math.max(0, Math.floor(Number(r.threshold))) : undefined,
    }));
  if (!items.length) throw badRequest("No rows with an sku column found");
  const result = await applyBulk({ items, reason: "ADJUSTMENT", note: "CSV stock import" }, req.admin!.name ?? "admin");
  await logActivity(req, "inventory.import", "Inventory", null, `${result.updated} SKUs updated from CSV`);
  res.json(result);
});

router.get("/inventory/movements", read, async (req, res) => {
  const reason = queryString(req, "reason");
  const q = queryString(req, "q");
  const from = queryString(req, "from");
  const to = queryString(req, "to");
  const where: Prisma.StockMovementWhereInput = {
    ...(queryString(req, "variantId") ? { variantId: queryString(req, "variantId") } : {}),
    ...(queryString(req, "warehouseId") ? { warehouseId: queryString(req, "warehouseId") } : {}),
    ...(reason ? { reason: reason as StockMovementReason } : {}),
    ...(q ? { OR: [{ variant: { sku: { contains: q, mode: "insensitive" } } }, { variant: { product: { name: { contains: q, mode: "insensitive" } } } }] } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999+05:30`) } : {}) } } : {}),
  };
  const include = {
    variant: { select: { sku: true, title: true, product: { select: { id: true, name: true } } } },
    warehouse: { select: { name: true, code: true } },
  } satisfies Prisma.StockMovementInclude;
  const format = queryString(req, "format");
  if (format) {
    const rows = await prisma.stockMovement.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 20000 });
    await sendExport(res, format, "stock-movements", rows, [
      { key: "createdAt", label: "Date", value: (r) => r.createdAt.toISOString().slice(0, 16).replace("T", " ") },
      { key: "sku", label: "SKU", value: (r) => r.variant.sku },
      { key: "product", label: "Product", value: (r) => r.variant.product.name },
      { key: "warehouse", label: "Warehouse", value: (r) => r.warehouse.code },
      { key: "reason", label: "Reason" },
      { key: "change", label: "Change" },
      { key: "balanceAfter", label: "Balance" },
      { key: "note", label: "Note" },
      { key: "actor", label: "By" },
    ]);
    return;
  }
  const { page, limit, skip, take } = pageArgs(req.query);
  const [total, items] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({ where, include, orderBy: { createdAt: "desc" }, skip, take }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), reasons: REASONS });
});

// ──────────────────────────────── Warehouses ─────────────────────────────────

registerCrud(router, "/inventory/warehouses", {
  model: prisma.warehouse,
  area: "inventory",
  entity: "Warehouse",
  createSchema: z.object({
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/),
    contactName: z.string().max(80).optional().nullable(),
    phone: z.string().max(20).optional().nullable(),
    address: z.string().max(300).optional().nullable(),
    city: z.string().max(80).optional().nullable(),
    state: z.string().max(80).optional().nullable(),
    pincode: z.string().max(10).optional().nullable(),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  }),
  orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  include: { _count: { select: { inventory: true } } },
  noDelete: true,
  transform: (data) => (data.code ? { ...data, code: String(data.code).toUpperCase() } : data),
  afterSave: async (row) => {
    if (row.isDefault) await prisma.warehouse.updateMany({ where: { id: { not: row.id } }, data: { isDefault: false } });
  },
});

router.delete("/inventory/warehouses/:id", write, async (req, res) => {
  const id = param(req, "id");
  const wh = await prisma.warehouse.findUnique({ where: { id } });
  if (!wh) throw notFound("Warehouse not found");
  if (wh.isDefault) throw badRequest("The default warehouse cannot be deleted");
  const units = await prisma.inventoryLevel.aggregate({ where: { warehouseId: id }, _sum: { quantity: true } });
  if ((units._sum.quantity ?? 0) > 0) throw badRequest("Transfer or clear the stock in this warehouse before deleting it");
  const transfers = await prisma.stockTransfer.count({ where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] } });
  if (transfers) {
    await prisma.warehouse.update({ where: { id }, data: { isActive: false } });
    res.json({ ok: true, deactivated: true });
    return;
  }
  await prisma.warehouse.delete({ where: { id } });
  await logActivity(req, "warehouse.delete", "Warehouse", id, wh.name);
  res.json({ ok: true });
});

// ───────────────────────────────── Transfers ─────────────────────────────────

const transferInclude = {
  fromWarehouse: { select: { id: true, name: true, code: true } },
  toWarehouse: { select: { id: true, name: true, code: true } },
  items: { include: { variant: { select: { id: true, sku: true, title: true, product: { select: { name: true } } } } } },
} satisfies Prisma.StockTransferInclude;

router.get("/inventory/transfers", read, async (req, res) => {
  const status = queryString(req, "status");
  const { page, limit, skip, take } = pageArgs(req.query);
  const where = status ? { status: status as TransferStatus } : {};
  const [total, items] = await Promise.all([
    prisma.stockTransfer.count({ where }),
    prisma.stockTransfer.findMany({ where, include: transferInclude, orderBy: { createdAt: "desc" }, skip, take }),
  ]);
  res.json({
    items: items.map((t) => ({ ...t, units: t.items.reduce((s, i) => s + i.quantity, 0) })),
    meta: pageMeta(total, page, limit),
  });
});

router.get("/inventory/transfers/:id", read, async (req, res) => {
  const t = await prisma.stockTransfer.findUnique({ where: { id: param(req, "id") }, include: transferInclude });
  if (!t) throw notFound("Transfer not found");
  res.json(t);
});

router.post("/inventory/transfers", write, async (req, res) => {
  const body = parse(
    z
      .object({
        fromWarehouseId: z.string(),
        toWarehouseId: z.string(),
        note: z.string().max(300).optional(),
        items: z.array(z.object({ variantId: z.string(), quantity: z.number().int().min(1) })).min(1).max(500),
        dispatch: z.boolean().default(false),
      })
      .refine((b) => b.fromWarehouseId !== b.toWarehouseId, { message: "Source and destination must differ", path: ["toWarehouseId"] }),
    req.body,
  );
  const t = await prisma.stockTransfer.create({
    data: {
      reference: `TR-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${randomDigits(4)}`,
      fromWarehouseId: body.fromWarehouseId,
      toWarehouseId: body.toWarehouseId,
      note: body.note,
      createdBy: req.admin!.name,
      items: { create: body.items },
    },
  });
  await logActivity(req, "transfer.create", "StockTransfer", t.id, t.reference);
  if (body.dispatch) await dispatchTransfer(t.id, req.admin!.name);
  res.status(201).json(await prisma.stockTransfer.findUnique({ where: { id: t.id }, include: transferInclude }));
});

async function dispatchTransfer(id: string, actor?: string) {
  await prisma.$transaction(async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw notFound("Transfer not found");
    if (t.status !== "PENDING") throw badRequest("Only pending transfers can be dispatched");
    for (const i of t.items) {
      await adjustStock(tx, { variantId: i.variantId, warehouseId: t.fromWarehouseId, change: -i.quantity, reason: "TRANSFER_OUT", referenceId: t.id, note: t.reference, actor });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "IN_TRANSIT" } });
  });
}

router.post("/inventory/transfers/:id/dispatch", write, async (req, res) => {
  await dispatchTransfer(param(req, "id"), req.admin!.name);
  await logActivity(req, "transfer.dispatch", "StockTransfer", param(req, "id"));
  res.json(await prisma.stockTransfer.findUnique({ where: { id: param(req, "id") }, include: transferInclude }));
});

router.post("/inventory/transfers/:id/receive", write, async (req, res) => {
  const id = param(req, "id");
  await prisma.$transaction(async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw notFound("Transfer not found");
    if (t.status === "PENDING") {
      for (const i of t.items) {
        await adjustStock(tx, { variantId: i.variantId, warehouseId: t.fromWarehouseId, change: -i.quantity, reason: "TRANSFER_OUT", referenceId: t.id, note: t.reference, actor: req.admin!.name });
      }
    } else if (t.status !== "IN_TRANSIT") throw badRequest("This transfer is already closed");
    for (const i of t.items) {
      await adjustStock(tx, { variantId: i.variantId, warehouseId: t.toWarehouseId, change: i.quantity, reason: "TRANSFER_IN", referenceId: t.id, note: t.reference, actor: req.admin!.name });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
  });
  await logActivity(req, "transfer.receive", "StockTransfer", id);
  res.json(await prisma.stockTransfer.findUnique({ where: { id }, include: transferInclude }));
});

router.post("/inventory/transfers/:id/cancel", write, async (req, res) => {
  const id = param(req, "id");
  await prisma.$transaction(async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw notFound("Transfer not found");
    if (t.status === "COMPLETED" || t.status === "CANCELLED") throw badRequest("This transfer is already closed");
    if (t.status === "IN_TRANSIT") {
      for (const i of t.items) {
        await adjustStock(tx, { variantId: i.variantId, warehouseId: t.fromWarehouseId, change: i.quantity, reason: "TRANSFER_IN", referenceId: t.id, note: `${t.reference} cancelled`, actor: req.admin!.name });
      }
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "CANCELLED" } });
  });
  await logActivity(req, "transfer.cancel", "StockTransfer", id);
  res.json({ ok: true });
});

router.get("/inventory/variants/search", read, async (req, res) => {
  const q = queryString(req, "q") ?? "";
  const variants = await prisma.productVariant.findMany({
    where: {
      isActive: true,
      OR: [{ sku: { contains: q, mode: "insensitive" } }, { product: { name: { contains: q, mode: "insensitive" } } }],
    },
    take: 20,
    select: {
      id: true,
      sku: true,
      title: true,
      price: true,
      product: { select: { id: true, name: true, price: true, images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } } } },
      inventory: { select: { warehouseId: true, quantity: true, reserved: true } },
    },
  });
  res.json(
    serialize(
      variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        name: v.product.name,
        productId: v.product.id,
        price: v.price ?? v.product.price,
        image: v.product.images[0]?.url ?? null,
        stock: v.inventory.reduce((s, l) => s + Math.max(0, l.quantity - l.reserved), 0),
        byWarehouse: Object.fromEntries(v.inventory.map((l) => [l.warehouseId, l.quantity])),
      })),
    ),
  );
});

export default router;
