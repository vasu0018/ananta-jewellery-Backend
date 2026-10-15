import { Prisma } from "@prisma/client";
import { num, round2 } from "./utils";

/** Prisma filter for flash sales that are live right now. */
export function liveFlashSaleWhere(now = new Date()): Prisma.FlashSaleWhereInput {
  return { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } };
}

/** Shared include used for product cards & listings. */
export function productCardInclude() {
  return {
    images: { orderBy: { sortOrder: "asc" }, take: 2 },
    category: { select: { id: true, name: true, slug: true } },
    variants: {
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
      include: { inventory: { where: { warehouse: { isActive: true } } } },
    },
    flashSales: { where: liveFlashSaleWhere(), orderBy: { endsAt: "asc" }, take: 1 },
  } satisfies Prisma.ProductInclude;
}

export type CardProduct = Prisma.ProductGetPayload<{ include: ReturnType<typeof productCardInclude> }>;

type FlashSaleLike = { name: string; endsAt: Date; discountType: "PERCENTAGE" | "FIXED"; discountValue: Prisma.Decimal };

export function applyFlashSale(price: number, sale?: FlashSaleLike | null) {
  if (!sale) return price;
  const v = num(sale.discountValue);
  const discounted = sale.discountType === "PERCENTAGE" ? price * (1 - v / 100) : price - v;
  return Math.max(0, Math.round(discounted));
}

export function variantStock(v: { inventory: { quantity: number; reserved: number }[] }) {
  return v.inventory.reduce((s, l) => s + Math.max(0, l.quantity - l.reserved), 0);
}

/** Effective selling price + MRP for a product/variant, including live flash sale. */
export function priceFor(
  product: { price: Prisma.Decimal; compareAtPrice: Prisma.Decimal | null },
  variant?: { price: Prisma.Decimal | null; compareAtPrice: Prisma.Decimal | null } | null,
  sale?: FlashSaleLike | null,
) {
  const base = num(variant?.price ?? product.price);
  const mrp = num(variant?.compareAtPrice ?? product.compareAtPrice) || 0;
  const price = applyFlashSale(base, sale);
  const compareAt = Math.max(mrp, sale ? base : 0) || null;
  const discountPct = compareAt && compareAt > price ? Math.round(((compareAt - price) / compareAt) * 100) : 0;
  return { price, compareAtPrice: compareAt && compareAt > price ? compareAt : null, discountPct };
}

export function toProductCard(p: CardProduct) {
  const sale = p.flashSales[0] ?? null;
  const def = p.variants[0];
  const pricing = priceFor(p, def, sale);
  const stock = p.variants.reduce((s, v) => s + variantStock(v), 0);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    sku: p.sku,
    ...pricing,
    image: p.images[0]?.url ?? null,
    hoverImage: p.images[1]?.url ?? null,
    category: p.category,
    material: p.material,
    colour: p.colour,
    stone: p.stone,
    occasions: p.occasions,
    ratingAvg: round2(num(p.ratingAvg)),
    ratingCount: p.ratingCount,
    isBestseller: p.isBestseller,
    isNewArrival: p.isNewArrival,
    inStock: stock > 0,
    stock,
    defaultVariantId: def?.id ?? null,
    variants: p.variants.map((v) => ({
      id: v.id,
      title: v.title,
      size: v.size,
      colour: v.colour,
      ...priceFor(p, v, sale),
      stock: variantStock(v),
    })),
    flashSale: sale ? { name: sale.name, endsAt: sale.endsAt } : null,
  };
}

export type ProductCard = ReturnType<typeof toProductCard>;
