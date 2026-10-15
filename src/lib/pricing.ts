import type { Coupon, PaymentMethod, ShippingRate } from "@prisma/client";
import { prisma, type Tx } from "./prisma";
import { liveFlashSaleWhere, priceFor, variantStock } from "./catalog";
import { getSetting } from "./settings";
import { num, round2 } from "./utils";

export type QuoteInput = {
  items: { variantId: string; quantity: number }[];
  couponCode?: string | null;
  state?: string | null;
  pincode?: string | null;
  paymentMethod?: PaymentMethod | null;
  shippingRateId?: string | null;
  giftWrap?: boolean;
  loyaltyPoints?: number;
  customerId?: string | null;
  email?: string | null;
};

export type QuoteLine = {
  variantId: string;
  productId: string;
  name: string;
  slug: string;
  sku: string;
  variantTitle: string | null;
  image: string | null;
  unitPrice: number;
  compareAtPrice: number | null;
  quantity: number;
  lineTotal: number;
  taxRate: number;
  weight: number;
  available: number;
  categoryId: string | null;
  collectionIds: string[];
};

export type ShippingOption = {
  id: string;
  name: string;
  price: number;
  originalPrice: number;
  minDays: number;
  maxDays: number;
  codAvailable: boolean;
  codFee: number;
};

const UNIT_LIMIT = 10;

/** Coupon validation shared by quote + order placement. Returns an error string or null. */
async function validateCoupon(
  db: Tx,
  coupon: Coupon | null,
  subtotal: number,
  customerId?: string | null,
  email?: string | null,
): Promise<string | null> {
  if (!coupon || !coupon.isActive) return "This coupon code is not valid";
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return "This coupon is not active yet";
  if (coupon.endsAt && coupon.endsAt < now) return "This coupon has expired";
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return "This coupon has reached its usage limit";
  if (coupon.minOrderValue && subtotal < num(coupon.minOrderValue)) {
    return `Add items worth ₹${Math.ceil(num(coupon.minOrderValue) - subtotal)} more to use this coupon`;
  }
  if (coupon.usagePerCustomer || coupon.firstOrderOnly) {
    const who = customerId ? { customerId } : email ? { email: email.toLowerCase() } : null;
    if (!who && coupon.firstOrderOnly) return "Sign in or enter your email to use this coupon";
    if (who) {
      if (coupon.usagePerCustomer) {
        const used = await db.couponRedemption.count({
          where: { couponId: coupon.id, order: { ...who, status: { not: "CANCELLED" } } },
        });
        if (used >= coupon.usagePerCustomer) return "You have already used this coupon";
      }
      if (coupon.firstOrderOnly) {
        const prior = await db.order.count({ where: { ...who, status: { not: "CANCELLED" } } });
        if (prior > 0) return "This coupon is valid on your first order only";
      }
    }
  }
  return null;
}

function couponEligible(coupon: Coupon, line: QuoteLine) {
  switch (coupon.scope) {
    case "CATEGORY":
      return !!line.categoryId && coupon.scopeIds.includes(line.categoryId);
    case "PRODUCT":
      return coupon.scopeIds.includes(line.productId);
    case "COLLECTION":
      return line.collectionIds.some((c) => coupon.scopeIds.includes(c));
    default:
      return true;
  }
}

function couponDiscount(coupon: Coupon, lines: QuoteLine[]) {
  const eligible = lines.filter((l) => couponEligible(coupon, l));
  const eligibleSubtotal = eligible.reduce((s, l) => s + l.lineTotal, 0);
  if (!eligible.length && coupon.type !== "FREE_SHIPPING") return { discount: 0, freeShipping: false, error: "This coupon doesn't apply to items in your bag" };
  switch (coupon.type) {
    case "PERCENTAGE": {
      let d = (eligibleSubtotal * num(coupon.value)) / 100;
      if (coupon.maxDiscount) d = Math.min(d, num(coupon.maxDiscount));
      return { discount: Math.round(d), freeShipping: false, error: null };
    }
    case "FIXED":
      return { discount: Math.min(num(coupon.value), eligibleSubtotal), freeShipping: false, error: null };
    case "FREE_SHIPPING":
      return { discount: 0, freeShipping: true, error: null };
    case "BUY_X_GET_Y": {
      const buy = coupon.buyQuantity ?? 1;
      const get = coupon.getQuantity ?? 1;
      const units = eligible.flatMap((l) => Array.from({ length: l.quantity }, () => l.unitPrice)).sort((a, b) => a - b);
      const freeUnits = Math.floor(units.length / (buy + get)) * get;
      if (!freeUnits) return { discount: 0, freeShipping: false, error: `Add ${buy + get - units.length} more eligible item(s) to unlock this offer` };
      return { discount: units.slice(0, freeUnits).reduce((s, p) => s + p, 0), freeShipping: false, error: null };
    }
  }
}

/** Pick the most specific active zone: pincode prefix > state > catch-all. */
async function shippingRatesFor(db: Tx, state?: string | null, pincode?: string | null) {
  const zones = await db.shippingZone.findMany({
    where: { isActive: true },
    include: { rates: { where: { isActive: true }, orderBy: { price: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });
  const st = state?.trim().toLowerCase();
  const pin = pincode?.trim();
  const byPin = pin ? zones.find((z) => z.pincodes.some((p) => p && pin.startsWith(p))) : undefined;
  const byState = st ? zones.find((z) => z.states.some((s) => s.toLowerCase() === st)) : undefined;
  const catchAll = zones.find((z) => z.states.length === 0 && z.pincodes.length === 0);
  return (byPin ?? byState ?? catchAll ?? zones[0])?.rates ?? [];
}

function rateApplies(rate: ShippingRate, subtotal: number, weightGrams: number) {
  const min = rate.minValue ? num(rate.minValue) : null;
  const max = rate.maxValue ? num(rate.maxValue) : null;
  const v = rate.type === "WEIGHT" ? weightGrams : rate.type === "PRICE" ? subtotal : null;
  if (v === null) return true;
  return (min === null || v >= min) && (max === null || v <= max);
}

/**
 * Builds a full price breakdown for a bag. This is the single source of truth for
 * the storefront cart/checkout, order placement and admin manual orders.
 */
export async function buildQuote(input: QuoteInput, db: Tx = prisma) {
  const [checkout, loyaltyCfg, payments] = await Promise.all([
    getSetting("checkout"),
    getSetting("loyalty"),
    getSetting("payments"),
  ]);
  const warnings: string[] = [];

  // Merge duplicate variant lines
  const qty = new Map<string, number>();
  for (const i of input.items) {
    if (!i.variantId || i.quantity <= 0) continue;
    qty.set(i.variantId, Math.min(UNIT_LIMIT, (qty.get(i.variantId) ?? 0) + Math.floor(i.quantity)));
  }

  const variants = await db.productVariant.findMany({
    where: { id: { in: [...qty.keys()] } },
    include: {
      inventory: { where: { warehouse: { isActive: true } } },
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
      product: {
        include: {
          images: { orderBy: { sortOrder: "asc" }, take: 1 },
          collections: { select: { id: true } },
          flashSales: { where: liveFlashSaleWhere(), take: 1 },
        },
      },
    },
  });

  const lines: QuoteLine[] = [];
  for (const v of variants) {
    if (!v.isActive || v.product.status !== "ACTIVE") {
      warnings.push(`${v.product.name} is no longer available and was removed`);
      continue;
    }
    const quantity = qty.get(v.id)!;
    const { price, compareAtPrice } = priceFor(v.product, v, v.product.flashSales[0]);
    const available = variantStock(v);
    if (available < quantity) {
      warnings.push(
        available > 0 ? `Only ${available} left of ${v.product.name}` : `${v.product.name} is out of stock`,
      );
    }
    lines.push({
      variantId: v.id,
      productId: v.productId,
      name: v.product.name,
      slug: v.product.slug,
      sku: v.sku,
      variantTitle: v.title === "Default" ? null : v.title,
      image: v.images[0]?.url ?? v.product.images[0]?.url ?? null,
      unitPrice: price,
      compareAtPrice,
      quantity,
      lineTotal: price * quantity,
      taxRate: num(v.product.taxRate),
      weight: num(v.weight ?? v.product.weight) || 10,
      available,
      categoryId: v.product.categoryId,
      collectionIds: v.product.collections.map((c) => c.id),
    });
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const weight = lines.reduce((s, l) => s + l.weight * l.quantity, 0);

  // ── Coupon
  let discount = 0;
  let freeShipping = false;
  let couponError: string | null = null;
  let coupon: Coupon | null = null;
  const code = input.couponCode?.trim().toUpperCase();
  if (code && lines.length) {
    coupon = await db.coupon.findUnique({ where: { code } });
    couponError = await validateCoupon(db, coupon, subtotal, input.customerId, input.email);
    if (!couponError && coupon) {
      const r = couponDiscount(coupon, lines);
      if (r.error) couponError = r.error;
      else {
        discount = Math.min(r.discount, subtotal);
        freeShipping = r.freeShipping;
      }
    }
  }

  // ── Customer group discount (stacks on what is left after the coupon)
  const couponAmount = round2(discount);
  let group: { name: string; percent: number; amount: number } | null = null;
  if (input.customerId && lines.length) {
    const c = await db.customer.findUnique({ where: { id: input.customerId }, select: { group: { select: { name: true, discountPct: true } } } });
    const percent = Math.min(90, num(c?.group?.discountPct));
    if (c?.group && percent > 0) {
      const amount = round2(((subtotal - discount) * percent) / 100);
      group = { name: c.group.name, percent, amount };
      discount += amount;
    }
  }

  // ── Loyalty points
  let loyaltyApplied = 0;
  let loyaltyBalance = 0;
  let loyaltyMax = 0;
  if (loyaltyCfg.enabled && input.customerId) {
    const c = await db.customer.findUnique({ where: { id: input.customerId }, select: { loyaltyPoints: true } });
    loyaltyBalance = c?.loyaltyPoints ?? 0;
    loyaltyMax = Math.floor(((subtotal - discount) * loyaltyCfg.maxRedeemPercent) / 100 / loyaltyCfg.pointValue);
    loyaltyApplied = Math.max(0, Math.min(input.loyaltyPoints ?? 0, loyaltyBalance, loyaltyMax));
  }
  const loyaltyValue = round2(loyaltyApplied * loyaltyCfg.pointValue);

  // ── Shipping
  const merchandise = subtotal - discount;
  const rates = lines.length ? await shippingRatesFor(db, input.state, input.pincode) : [];
  const shippingOptions: ShippingOption[] = rates
    .filter((r) => rateApplies(r, subtotal, weight))
    .map((r, index) => {
      const original = num(r.price);
      // Store-wide threshold makes the cheapest method free; per-rate freeAbove applies to that rate.
      const free =
        freeShipping ||
        (r.freeAbove !== null && merchandise >= num(r.freeAbove)) ||
        (index === 0 && checkout.freeShippingAbove > 0 && merchandise >= checkout.freeShippingAbove);
      return {
        id: r.id,
        name: r.name,
        price: free ? 0 : original,
        originalPrice: original,
        minDays: r.minDays,
        maxDays: r.maxDays,
        codAvailable: r.codAvailable,
        codFee: num(r.codFee) || checkout.codFee,
      };
    });
  const selected = shippingOptions.find((o) => o.id === input.shippingRateId) ?? shippingOptions[0] ?? null;
  const shippingFee = lines.length ? selected?.price ?? 0 : 0;

  // ── COD
  const codAllowedGlobally = checkout.codEnabled && payments.methods.cod;
  const codAvailable =
    codAllowedGlobally &&
    (selected?.codAvailable ?? true) &&
    (!checkout.codMaxOrderValue || merchandise <= checkout.codMaxOrderValue);
  const codFee = input.paymentMethod === "COD" && codAvailable ? selected?.codFee ?? checkout.codFee : 0;

  const giftWrapFee = input.giftWrap ? checkout.giftWrapFee : 0;
  const total = round2(Math.max(0, subtotal - discount - loyaltyValue + shippingFee + codFee + giftWrapFee));

  // ── GST (prices are tax inclusive): back-calculate tax per line on the discounted amount
  const reduction = discount + loyaltyValue;
  const taxTotal = round2(
    lines.reduce((s, l) => {
      const share = subtotal ? (l.lineTotal / subtotal) * reduction : 0;
      const taxable = l.lineTotal - share;
      return s + (taxable - taxable / (1 + l.taxRate / 100));
    }, 0),
  );

  const mrpSavings = lines.reduce((s, l) => s + ((l.compareAtPrice ?? l.unitPrice) - l.unitPrice) * l.quantity, 0);

  return {
    lines,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    couponCode: coupon && !couponError ? coupon.code : null,
    coupon: coupon && !couponError ? { code: coupon.code, type: coupon.type, description: coupon.description } : null,
    couponError: code ? couponError : null,
    discount: round2(discount),
    couponDiscount: couponAmount,
    groupDiscount: group,
    freeShipping,
    shippingOptions,
    shippingRateId: selected?.id ?? null,
    shippingMethod: selected?.name ?? null,
    shippingFee,
    codAvailable,
    codFee,
    giftWrapFee,
    loyalty: {
      enabled: loyaltyCfg.enabled,
      balance: loyaltyBalance,
      maxRedeemable: Math.min(loyaltyBalance, loyaltyMax),
      applied: loyaltyApplied,
      value: loyaltyValue,
    },
    taxTotal,
    total,
    savings: round2(mrpSavings + discount),
    weight,
    warnings,
  };
}

export type Quote = Awaited<ReturnType<typeof buildQuote>>;
