import type { StockMovementReason } from "@prisma/client";
import { prisma, type Tx } from "./prisma";
import { conflict } from "./http";
import { notifyAdmins } from "./audit";

export async function defaultWarehouseId(db: Tx = prisma) {
  const wh =
    (await db.warehouse.findFirst({ where: { isDefault: true, isActive: true } })) ??
    (await db.warehouse.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } }));
  if (!wh) throw conflict("No active warehouse configured");
  return wh.id;
}

/** Available units per variant across active warehouses. */
export async function availability(variantIds: string[], db: Tx = prisma) {
  const levels = await db.inventoryLevel.findMany({
    where: { variantId: { in: variantIds }, warehouse: { isActive: true } },
  });
  const map = new Map<string, number>();
  for (const id of variantIds) map.set(id, 0);
  for (const l of levels) map.set(l.variantId, (map.get(l.variantId) ?? 0) + Math.max(0, l.quantity - l.reserved));
  return map;
}

/**
 * Apply a stock change in one warehouse and record a StockMovement.
 * `set` replaces the absolute quantity instead of applying a delta.
 */
export async function adjustStock(
  db: Tx,
  input: {
    variantId: string;
    warehouseId?: string;
    change?: number;
    set?: number;
    reason: StockMovementReason;
    note?: string;
    referenceId?: string;
    actor?: string;
    allowNegative?: boolean;
  },
) {
  const warehouseId = input.warehouseId ?? (await defaultWarehouseId(db));
  const level = await db.inventoryLevel.upsert({
    where: { variantId_warehouseId: { variantId: input.variantId, warehouseId } },
    create: { variantId: input.variantId, warehouseId, quantity: 0 },
    update: {},
  });
  const delta = input.set !== undefined ? input.set - level.quantity : input.change ?? 0;
  if (delta === 0) return level;
  const next = level.quantity + delta;
  if (next < 0 && !input.allowNegative) throw conflict("Insufficient stock for this adjustment");
  const updated = await db.inventoryLevel.update({
    where: { id: level.id },
    data: { quantity: next },
  });
  await db.stockMovement.create({
    data: {
      variantId: input.variantId,
      warehouseId,
      change: delta,
      balanceAfter: next,
      reason: input.reason,
      note: input.note,
      referenceId: input.referenceId,
      actor: input.actor,
    },
  });
  return updated;
}

/** Deduct order quantities, preferring the default warehouse then the fullest one. */
export async function deductForOrder(
  db: Tx,
  items: { variantId: string | null; quantity: number; sku: string }[],
  orderId: string,
) {
  const low: string[] = [];
  for (const item of items) {
    if (!item.variantId) continue;
    let remaining = item.quantity;
    const levels = await db.inventoryLevel.findMany({
      where: { variantId: item.variantId, warehouse: { isActive: true } },
      include: { warehouse: true },
    });
    levels.sort(
      (a, b) =>
        Number(b.warehouse.isDefault) - Number(a.warehouse.isDefault) ||
        b.quantity - b.reserved - (a.quantity - a.reserved),
    );
    for (const l of levels) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Math.max(0, l.quantity - l.reserved));
      if (take <= 0) continue;
      const updated = await adjustStock(db, {
        variantId: item.variantId,
        warehouseId: l.warehouseId,
        change: -take,
        reason: "SALE",
        referenceId: orderId,
      });
      if (updated.quantity <= updated.lowStockThreshold) low.push(item.sku);
      remaining -= take;
    }
    if (remaining > 0) throw conflict(`Only limited stock left for ${item.sku}. Please update your bag.`);
  }
  if (low.length) {
    void notifyAdmins({
      type: "LOW_STOCK",
      title: `Low stock: ${low.slice(0, 3).join(", ")}${low.length > 3 ? ` +${low.length - 3}` : ""}`,
      body: "Some SKUs have reached their low stock threshold.",
      link: "/dashboard/inventory/low-stock",
    });
  }
}

/** Variants at or below their low-stock threshold (summed over active warehouses). */
export async function lowStockVariants(limit = 500) {
  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, product: { status: { not: "ARCHIVED" } } },
    select: {
      id: true,
      sku: true,
      title: true,
      product: { select: { id: true, name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } },
      inventory: { where: { warehouse: { isActive: true } }, select: { quantity: true, reserved: true, lowStockThreshold: true } },
    },
  });
  return variants
    .map((v) => {
      const available = v.inventory.reduce((s, l) => s + Math.max(0, l.quantity - l.reserved), 0);
      const threshold = v.inventory.length ? Math.max(...v.inventory.map((l) => l.lowStockThreshold)) : 5;
      return {
        variantId: v.id,
        productId: v.product.id,
        sku: v.sku,
        name: v.product.name,
        variantTitle: v.title,
        image: v.product.images[0]?.url ?? null,
        available,
        threshold,
      };
    })
    .filter((v) => v.available <= v.threshold)
    .sort((a, b) => a.available - b.available)
    .slice(0, limit);
}

/** Put order quantities back into the default warehouse (cancel / return). */
export async function restockItems(
  db: Tx,
  items: { variantId: string | null; quantity: number }[],
  reason: StockMovementReason,
  referenceId: string,
  actor?: string,
) {
  const warehouseId = await defaultWarehouseId(db);
  for (const item of items) {
    if (!item.variantId || item.quantity <= 0) continue;
    await adjustStock(db, { variantId: item.variantId, warehouseId, change: item.quantity, reason, referenceId, actor });
  }
}
