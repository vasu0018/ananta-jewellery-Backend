/**
 * Demo data for Ananta Jewellery.
 *   npm run db:seed
 * WARNING: wipes every table (except migrations) before inserting.
 */
import fs from "fs/promises";
import path from "path";
import type { OrderStatus, PaymentMethod, Prisma, ShipmentStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { hashPassword } from "../src/lib/auth";
import { ROLE_PRESETS } from "../src/lib/permissions";
import { recomputeRating } from "../src/lib/reviews";
import { round2, slugify } from "../src/lib/utils";
import { registerSeedMedia } from "./seed/media";
import { bannerSvg, BACKGROUNDS, productSvg, swatchSvg, tileSvg, type Kind } from "./seed/svg";
import { CATEGORIES, COLLECTIONS, CUSTOMERS, EMAIL_TEMPLATES, POSTS, PRODUCTS, REVIEW_SNIPPETS, TAGS, type ProductSpec } from "./seed/data";

// ── Deterministic randomness so every seed run produces the same store ────────
let rngState = 20261015;
function rng() {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rng() * arr.length)];
const chance = (p: number) => rng() < p;
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (d: number, h = 0) => new Date(now.getTime() - d * DAY - h * 3_600_000);
const hoursAfter = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

const SEED_DIR = path.resolve(process.cwd(), env.UPLOAD_DIR, "seed");
const PHOTO_DIR = path.resolve(process.cwd(), "prisma", "seed", "photos");
/** Uses the photo from prisma/seed/photos when there is one, otherwise the generated SVG. */
async function writeArt(name: string, svg: string) {
  try {
    await fs.copyFile(path.join(PHOTO_DIR, `${name}.webp`), path.join(SEED_DIR, `${name}.webp`));
    return `/uploads/seed/${name}.webp`;
  } catch {
    await fs.writeFile(path.join(SEED_DIR, `${name}.svg`), svg, "utf8");
    return `/uploads/seed/${name}.svg`;
  }
}

async function wipe() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1`);
  await fs.rm(SEED_DIR, { recursive: true, force: true });
  await fs.mkdir(SEED_DIR, { recursive: true });
}

const CAT_CODE: Record<string, string> = {
  rings: "RNG", studs: "EAR", hoops: "EAR", "drops-jhumkas": "EAR", pendants: "PND", "chains-chokers": "NCK", bracelets: "BRC",
  bangles: "BNG", anklets: "ANK", mangalsutra: "MNG", "nose-pins": "NSP", "mens-rings": "MRG", "mens-chains": "MCH", "mens-bracelets": "MBR",
};

const DEFAULT_WEIGHT: Partial<Record<Kind, number>> = {
  ring: 2.8, mensring: 6, stud: 1.6, hoop: 3.2, drop: 4.5, jhumka: 9, pendant: 3.5, heart: 3.8, necklace: 8, chain: 12,
  bracelet: 6.5, bangle: 16, kada: 20, anklet: 8, mangalsutra: 7, nosepin: 0.4,
};

function sizeGuideFor(kind: Kind, sizes?: string[]) {
  if (!sizes?.length || sizes[0] === "Adjustable") return null;
  if (kind === "ring" || kind === "mensring") return "RING";
  if (kind === "bangle" || kind === "kada") return "BANGLE";
  if (kind === "chain" || kind === "pendant" || kind === "heart") return "CHAIN";
  return "BRACELET";
}

function variantTitle(kind: Kind, size: string) {
  if (size === "Adjustable") return "Adjustable";
  if (size.includes('"')) return `${size} chain`;
  return `Size ${size}`;
}

function describe(p: ProductSpec) {
  const stone = p.stone === "None" ? "" : p.stone === "Lab Grown Diamond" ? " set with an IGI-certified lab-grown diamond" : ` set with brilliant ${p.stone.toLowerCase()}${p.stone === "Pearl" ? "s" : " stones"}`;
  const base = p.material ?? (p.metal === "Silver" ? "925 sterling silver" : p.metal === "Oxidised" ? "oxidised 925 silver" : `925 silver with ${p.metal.toLowerCase()} plating`);
  return `<p>The <strong>${p.name}</strong> is handcrafted in ${base}${stone}. Designed for ${p.occasions.join(" and ").toLowerCase()}, it pairs effortlessly with both ethnic and western looks.</p>
<ul><li>Hypoallergenic, nickel-free and skin safe</li><li>Hallmarked metal with certificate of authenticity</li><li>Comes in a signature Ananta gift box</li><li>30-day easy returns · Lifetime plating service</li></ul>`;
}

async function main() {
  console.log("✦ Seeding Ananta Jewellery…");
  await wipe();

  // ── Roles & admin users ────────────────────────────────────────────────────
  const roles: Record<string, string> = {};
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    const r = await prisma.role.create({ data: { key, name: preset.name, description: preset.description, permissions: [...preset.permissions], isSystem: true } });
    roles[key] = r.id;
  }
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || "admin@anantajewellery.in").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "Admin@123";
  const admin = await prisma.adminUser.create({
    data: { name: "Ananta Admin", email: adminEmail, phone: "9876543210", passwordHash: await hashPassword(adminPassword), roleId: roles.ADMIN },
  });
  await prisma.adminUser.create({ data: { name: "Kiran Desai", email: "manager@anantajewellery.in", passwordHash: await hashPassword("Manager@123"), roleId: roles.MANAGER } });
  await prisma.adminUser.create({ data: { name: "Ravi Patel", email: "staff@anantajewellery.in", passwordHash: await hashPassword("Staff@123"), roleId: roles.STAFF } });
  console.log("  roles & admin users");

  // ── Warehouses ─────────────────────────────────────────────────────────────
  const surat = await prisma.warehouse.create({
    data: { name: "Surat Main Warehouse", code: "SURAT", contactName: "Ravi Patel", phone: "9876543211", address: "Plot 12, GIDC Sachin", city: "Surat", state: "Gujarat", pincode: "394230", isDefault: true },
  });
  const mumbai = await prisma.warehouse.create({
    data: { name: "Mumbai Fulfilment Hub", code: "MUMBAI", contactName: "Sana Khan", phone: "9876543212", address: "Unit 4, Andheri East", city: "Mumbai", state: "Maharashtra", pincode: "400069" },
  });

  // ── Categories ─────────────────────────────────────────────────────────────
  const catIds: Record<string, string> = {};
  for (const [i, c] of CATEGORIES.entries()) {
    const image = await writeArt(`category-${c.slug}`, tileSvg(c.kind, c.metal, c.stone, BACKGROUNDS[i % BACKGROUNDS.length]));
    const bannerImage = await writeArt(`category-${c.slug}-banner`, bannerSvg(c.kind, c.metal, c.stone, BACKGROUNDS[i % BACKGROUNDS.length], "#ffffff"));
    const parent = await prisma.category.create({
      data: { name: c.name, slug: c.slug, description: c.description, image, bannerImage, sortOrder: i, seoTitle: `${c.name} – Silver & Lab-Grown Diamond ${c.name} Online` },
    });
    catIds[c.slug] = parent.id;
    for (const [j, ch] of (c.children ?? []).entries()) {
      const img = await writeArt(`category-${ch.slug}`, tileSvg(ch.kind, ch.metal, ch.stone, BACKGROUNDS[(i + j + 2) % BACKGROUNDS.length]));
      const child = await prisma.category.create({ data: { name: ch.name, slug: ch.slug, image: img, parentId: parent.id, sortOrder: j } });
      catIds[ch.slug] = child.id;
    }
  }

  // ── Collections & tags ─────────────────────────────────────────────────────
  const colIds: Record<string, string> = {};
  for (const [i, c] of COLLECTIONS.entries()) {
    const image =
      "swatch" in c.art
        ? await writeArt(`collection-${c.slug}`, swatchSvg(c.art.swatch))
        : await writeArt(`collection-${c.slug}`, tileSvg(c.art.kind, c.art.metal, c.art.stone, c.art.bg));
    const bannerArt = "swatch" in c.art ? { kind: "ring" as Kind, metal: c.art.swatch, stone: "Zircon" as const, bg: "#f6f1e7" } : c.art;
    const bannerImage = await writeArt(`collection-${c.slug}-banner`, bannerSvg(bannerArt.kind, bannerArt.metal, bannerArt.stone, bannerArt.bg, "#ffffff"));
    const row = await prisma.collection.create({
      data: { name: c.name, slug: c.slug, type: c.type, description: c.description, image, bannerImage, isFeatured: !!c.featured, sortOrder: i },
    });
    colIds[c.slug] = row.id;
  }
  const tagIds: Record<string, string> = {};
  for (const t of TAGS) tagIds[t.slug] = (await prisma.tag.create({ data: t })).id;
  console.log("  categories, collections & tags");

  // ── Products ───────────────────────────────────────────────────────────────
  type SeededVariant = { id: string; sku: string; title: string; price: number; productId: string };
  const products: { id: string; spec: ProductSpec; name: string; image: string; variants: SeededVariant[]; createdAt: Date }[] = [];
  const movements: Prisma.StockMovementCreateManyInput[] = [];

  for (const [i, spec] of PRODUCTS.entries()) {
    const slug = slugify(spec.name);
    const sku = `AJ-${CAT_CODE[spec.cat] ?? "GEN"}-${101 + i}`;
    const images: string[] = [];
    for (let n = 0; n < 3; n++) images.push(await writeArt(`product-${slug}-${n + 1}`, productSvg(spec.kind, spec.metal, spec.stone, n, i)));
    const createdAt = spec.flags?.includes("N") ? daysAgo(int(2, 25)) : daysAgo(int(40, 160));
    const sizes = spec.sizes ?? [];
    const variantInputs = (sizes.length ? sizes : ["Default"]).map((s, j) => {
      const isChainUpgrade = s.includes('"') && j > 0;
      return {
        sku: sizes.length ? `${sku}-${slugify(s) || j}` : sku,
        title: sizes.length ? variantTitle(spec.kind, s) : "Default",
        size: sizes.length && s !== "Adjustable" ? s : null,
        price: isChainUpgrade ? spec.price + 200 : null,
        compareAtPrice: isChainUpgrade ? spec.mrp + 300 : null,
        isDefault: j === 0,
        sortOrder: j,
      };
    });
    const material =
      spec.material ?? (spec.metal === "Silver" ? "925 Sterling Silver" : spec.metal === "Oxidised" ? "925 Oxidised Silver" : `925 Silver, ${spec.metal === "Gold" ? "18K Gold" : "Rose Gold"} Plated`);

    const product = await prisma.product.create({
      data: {
        name: spec.name,
        slug,
        sku,
        shortDescription: `${material}${spec.stone !== "None" ? ` · ${spec.stone}` : ""} · ${spec.occasions[0]}`,
        description: describe(spec),
        categoryId: catIds[spec.cat],
        status: "ACTIVE",
        material,
        colour: spec.metal,
        stone: spec.stone,
        occasions: spec.occasions,
        gender: spec.gender ?? "Women",
        price: spec.price,
        compareAtPrice: spec.mrp,
        costPrice: Math.round(spec.price * 0.36),
        weight: spec.weight ?? DEFAULT_WEIGHT[spec.kind] ?? 3,
        length: 8,
        width: 6,
        height: 3,
        sizeGuide: sizeGuideFor(spec.kind, spec.sizes),
        careInstructions: "Store in the anti-tarnish pouch provided. Avoid contact with perfume, water and chemicals. Wipe with a soft cloth after use.",
        warranty: spec.stone === "Lab Grown Diamond" ? "Lifetime exchange · IGI certificate included" : "6-month warranty · Lifetime plating service",
        hasCertificate: true,
        isFeatured: !!spec.flags?.includes("F"),
        isBestseller: !!spec.flags?.includes("B"),
        isNewArrival: !!spec.flags?.includes("N"),
        isGiftable: true,
        viewCount: int(120, 2400),
        seoTitle: `${spec.name} | Ananta Jewellery`,
        seoDescription: `Buy ${spec.name} online at ₹${spec.price}. ${material}. Free shipping above ₹999, COD available, 30-day returns.`,
        publishedAt: createdAt,
        createdAt,
        collections: { connect: spec.collections.filter((c) => colIds[c]).map((c) => ({ id: colIds[c] })) },
        tags: { connect: spec.tags.filter((t) => tagIds[t]).map((t) => ({ id: tagIds[t] })) },
        images: { create: images.map((url, n) => ({ url, alt: `${spec.name} – view ${n + 1}`, sortOrder: n })) },
        variants: { create: variantInputs },
      },
      include: { variants: true },
    });

    const seeded: SeededVariant[] = [];
    for (const [j, v] of product.variants.sort((a, b) => a.sortOrder - b.sortOrder).entries()) {
      // A handful of SKUs are deliberately low / out of stock for the dashboard alerts.
      let qty = int(8, 45);
      if (i % 9 === 4 && j === 0) qty = int(1, 3);
      if (i % 13 === 6 && j === product.variants.length - 1) qty = 0;
      await prisma.inventoryLevel.create({ data: { variantId: v.id, warehouseId: surat.id, quantity: qty, lowStockThreshold: 5 } });
      movements.push({ variantId: v.id, warehouseId: surat.id, change: qty, balanceAfter: qty, reason: "RESTOCK", note: "Opening stock", actor: "Seed", createdAt });
      if (chance(0.4) && qty > 0) {
        const m = int(3, 12);
        await prisma.inventoryLevel.create({ data: { variantId: v.id, warehouseId: mumbai.id, quantity: m, lowStockThreshold: 3 } });
        movements.push({ variantId: v.id, warehouseId: mumbai.id, change: m, balanceAfter: m, reason: "RESTOCK", note: "Opening stock", actor: "Seed", createdAt });
      }
      seeded.push({ id: v.id, sku: v.sku, title: v.title, price: v.price ? Number(v.price) : spec.price, productId: product.id });
    }
    products.push({ id: product.id, spec, name: product.name, image: images[0], variants: seeded, createdAt });
  }
  await prisma.stockMovement.createMany({ data: movements });
  console.log(`  ${products.length} products with variants, images & stock`);

  // ── Shipping ───────────────────────────────────────────────────────────────
  await prisma.shippingZone.create({
    data: {
      name: "Gujarat (Local)",
      states: ["Gujarat"],
      sortOrder: 0,
      rates: {
        create: [
          { name: "Standard", price: 49, minDays: 2, maxDays: 4, codFee: 49 },
          { name: "Express", price: 99, minDays: 1, maxDays: 2, codFee: 49 },
        ],
      },
    },
  });
  await prisma.shippingZone.create({
    data: {
      name: "Metro Cities",
      pincodes: ["110", "400", "560", "600", "700", "500", "411"],
      sortOrder: 1,
      rates: {
        create: [
          { name: "Standard", price: 59, minDays: 3, maxDays: 5, codFee: 49 },
          { name: "Express", price: 129, minDays: 1, maxDays: 3, codFee: 49 },
        ],
      },
    },
  });
  await prisma.shippingZone.create({
    data: {
      name: "North East, J&K & Islands",
      states: ["Assam", "Arunachal Pradesh", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Sikkim", "Tripura", "Jammu and Kashmir", "Ladakh", "Andaman and Nicobar Islands", "Lakshadweep"],
      sortOrder: 2,
      rates: { create: [{ name: "Standard", price: 99, minDays: 6, maxDays: 10, codAvailable: false }] },
    },
  });
  await prisma.shippingZone.create({
    data: {
      name: "Rest of India",
      sortOrder: 3,
      rates: {
        create: [
          { name: "Standard", price: 79, minDays: 4, maxDays: 7, codFee: 49 },
          { name: "Express", price: 149, minDays: 2, maxDays: 4, codFee: 49 },
        ],
      },
    },
  });
  const manualPartner = await prisma.shippingPartner.create({
    data: { name: "Manual / Self ship", code: "MANUAL", isActive: true, isDefault: true, mode: "LIVE", trackingUrl: null },
  });
  await prisma.shippingPartner.createMany({
    data: [
      { name: "Shiprocket", code: "SHIPROCKET", trackingUrl: "https://shiprocket.co/tracking/{awb}" },
      { name: "Delhivery", code: "DELHIVERY", trackingUrl: "https://www.delhivery.com/track/package/{awb}" },
      { name: "India Post", code: "INDIA_POST", trackingUrl: "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx" },
    ],
  });
  console.log("  shipping zones, rates & partners");

  // ── Marketing ──────────────────────────────────────────────────────────────
  const coupons = {
    WELCOME10: await prisma.coupon.create({ data: { code: "WELCOME10", description: "10% off your first order (up to ₹500)", type: "PERCENTAGE", value: 10, maxDiscount: 500, firstOrderOnly: true, usagePerCustomer: 1 } }),
    FLAT200: await prisma.coupon.create({ data: { code: "FLAT200", description: "₹200 off on orders above ₹1,499", type: "FIXED", value: 200, minOrderValue: 1499 } }),
    FREESHIP: await prisma.coupon.create({ data: { code: "FREESHIP", description: "Free shipping on any order", type: "FREE_SHIPPING", minOrderValue: 499 } }),
    BUY2GET1: await prisma.coupon.create({ data: { code: "BUY2GET1", description: "Buy any 2, get the 3rd (lowest priced) free", type: "BUY_X_GET_Y", buyQuantity: 2, getQuantity: 1 } }),
    RAKHI15: await prisma.coupon.create({
      data: { code: "RAKHI15", description: "15% off gifts for your sister", type: "PERCENTAGE", value: 15, maxDiscount: 750, scope: "COLLECTION", scopeIds: [colIds["for-sister"]], endsAt: daysAgo(-20) },
    }),
    VIP500: await prisma.coupon.create({ data: { code: "VIP500", description: "₹500 off for VIP customers on ₹4,999+", type: "FIXED", value: 500, minOrderValue: 4999, isPublic: false, usageLimit: 100 } }),
  };
  const saleProducts = products.filter((p) => p.spec.flags?.includes("B")).slice(0, 7);
  await prisma.flashSale.create({
    data: {
      name: "Festive Flash Sale",
      description: "Extra 20% off our bestsellers — for 72 hours only.",
      discountType: "PERCENTAGE",
      discountValue: 20,
      bannerImage: await writeArt("flash-sale", bannerSvg("jhumka", "Gold", "Ruby", "#fbeff0", "#f6f1e7", "left")),
      startsAt: daysAgo(1),
      endsAt: daysAgo(-3),
      products: { connect: saleProducts.map((p) => ({ id: p.id })) },
    },
  });
  await prisma.flashSale.create({
    data: {
      name: "Lab Grown Diamond Week",
      description: "Flat ₹2,000 off lab-grown diamonds.",
      discountType: "FIXED",
      discountValue: 2000,
      startsAt: daysAgo(-10),
      endsAt: daysAgo(-17),
      products: { connect: products.filter((p) => p.spec.stone === "Lab Grown Diamond").map((p) => ({ id: p.id })) },
    },
  });

  const banners: Prisma.BannerCreateManyInput[] = [
    { title: "Sparkle in Every Moment", subtitle: "Fine 925 silver & lab-grown diamond jewellery, starting ₹499", eyebrow: "New Festive Collection", image: await writeArt("banner-hero-1", bannerSvg("necklace", "Gold", "Pearl", "#f6f1e7", "#fbeff0")), link: "/collections/wedding-festive", ctaLabel: "Shop the collection", placement: "HOME_HERO", sortOrder: 0 },
    { title: "Lab Grown Diamonds", subtitle: "IGI certified. 70% lighter on your pocket, 100% real.", eyebrow: "Forever, responsibly", image: await writeArt("banner-hero-2", bannerSvg("ring", "Gold", "Lab Grown Diamond", "#eef2f7", "#f3eef6")), link: "/collections/lab-grown-diamonds", ctaLabel: "Explore diamonds", placement: "HOME_HERO", sortOrder: 1 },
    { title: "Gifts She'll Treasure", subtitle: "Pendants, studs & bracelets wrapped and ready to gift", eyebrow: "Gifting Store", image: await writeArt("banner-hero-3", bannerSvg("heart", "Rose Gold", "Zircon", "#fbeff0", "#f7efe9")), link: "/gifting", ctaLabel: "Find a gift", placement: "HOME_HERO", sortOrder: 2 },
    { title: "Flat ₹200 Off", subtitle: "On orders above ₹1,499 · Code FLAT200", image: await writeArt("banner-promo-1", bannerSvg("hoop", "Gold", "None", "#f5efe4", "#ffffff", "left")), link: "/shop", ctaLabel: "Shop now", placement: "HOME_PROMO", sortOrder: 0 },
    { title: "For Him", subtitle: "Bold chains, bands & kadas", image: await writeArt("banner-promo-2", bannerSvg("chain", "Silver", "None", "#eef2f7", "#ffffff", "left")), link: "/collections/for-him", ctaLabel: "Shop men", placement: "HOME_PROMO", sortOrder: 1 },
    { title: "Free shipping above ₹999 · COD available · 30-day returns", image: await writeArt("banner-strip", bannerSvg("stud", "Silver", "Zircon", "#f3eef6", "#fbeff0")), link: "/shop", placement: "HOME_STRIP", sortOrder: 0 },
    { title: "The Gifting Edit", subtitle: "Curated gifts for every bond and budget", image: await writeArt("banner-gifting", bannerSvg("pendant", "Rose Gold", "Zircon", "#fbeff0", "#f6f1e7")), link: "/gifting", ctaLabel: "Explore gifts", placement: "GIFTING", sortOrder: 0 },
    { title: "Rings for Every Story", subtitle: "Solitaires, bands & cocktail rings", image: await writeArt("banner-category-rings", bannerSvg("ring", "Silver", "Zircon", "#eef3f1", "#ffffff")), link: "/category/rings", placement: "CATEGORY", categoryId: catIds.rings, sortOrder: 0 },
  ];
  await prisma.banner.createMany({ data: banners });
  await prisma.emailTemplate.createMany({ data: EMAIL_TEMPLATES });
  for (const [i, post] of POSTS.entries()) {
    const cover = await writeArt(`blog-${slugify(post.title)}`, bannerSvg(post.art.kind, post.art.metal, post.art.stone, post.art.from, post.art.to, i % 2 ? "left" : "right"));
    await prisma.blogPost.create({
      data: {
        title: post.title,
        slug: slugify(post.title),
        type: post.type,
        excerpt: post.excerpt,
        content: post.content,
        coverImage: cover,
        tags: post.tags,
        status: "PUBLISHED",
        publishedAt: daysAgo(5 + i * 9),
        seoDescription: post.excerpt,
      },
    });
  }
  console.log("  coupons, flash sales, banners, email templates & blog");

  // ── Customers ──────────────────────────────────────────────────────────────
  const vip = await prisma.customerGroup.create({ data: { name: "VIP", description: "Customers with lifetime value above ₹10,000", discountPct: 5 } });
  await prisma.customerGroup.create({ data: { name: "Corporate Gifting", description: "Bulk / corporate buyers" } });
  const customerPassword = await hashPassword("Customer@123");
  const customers: (Prisma.CustomerGetPayload<object> & { address: (typeof CUSTOMERS)[number]; registered: boolean; points: number })[] = [];
  for (const [i, c] of CUSTOMERS.entries()) {
    const registered = i < 10;
    const createdAt = daysAgo(int(95, 300));
    const customer = await prisma.customer.create({
      data: {
        name: c.name,
        email: c.email,
        phone: c.phone,
        passwordHash: registered ? customerPassword : null,
        emailVerified: registered,
        gender: i >= 10 && i <= 11 ? "Male" : "Female",
        tags: registered ? [] : ["guest"],
        createdAt,
        addresses: { create: { name: c.name, phone: c.phone, line1: c.line1, city: c.city, state: c.state, pincode: c.pincode, isDefault: true } },
      },
    });
    if (registered) {
      await prisma.loyaltyTransaction.create({ data: { customerId: customer.id, type: "EARN", points: 100, note: "Welcome bonus", createdAt } });
    }
    customers.push({ ...customer, address: c, registered, points: registered ? 100 : 0 });
  }
  console.log(`  ${customers.length} customers`);

  // ── Orders ─────────────────────────────────────────────────────────────────
  const COURIERS = ["Delhivery", "Blue Dart", "Ecom Express", "Xpressbees", "DTDC"];
  const usedNumbers = new Set<string>();
  const customerOrderCount = new Map<string, number>();
  const sold = new Map<string, number>();
  const deliveredPurchases: { customerId: string; name: string; productId: string; at: Date }[] = [];
  const paymentsForSettlement: { id: string; amount: number; capturedAt: Date }[] = [];
  let invoiceSeq = 0;
  let ndrCreated = false;
  const ORDER_COUNT = 72;

  for (let k = 0; k < ORDER_COUNT; k++) {
    const age = Math.floor(Math.pow(rng(), 1.5) * 95);
    const placedAt = daysAgo(age, int(0, 20));
    const customer = k % 5 === 0 ? customers[0] : pick(customers);
    const lineCount = chance(0.55) ? 1 : chance(0.7) ? 2 : 3;
    const chosen = new Map<string, { product: (typeof products)[number]; variant: SeededVariant; qty: number }>();
    for (let l = 0; l < lineCount; l++) {
      const pool = chance(0.6) ? products.filter((p) => p.spec.flags?.includes("B")) : products;
      const product = pick(pool);
      if (product.createdAt > placedAt) continue;
      const variant = pick(product.variants);
      chosen.set(variant.id, { product, variant, qty: chance(0.15) ? 2 : 1 });
    }
    if (!chosen.size) {
      const product = products.find((p) => p.createdAt <= placedAt) ?? products[0];
      chosen.set(product.variants[0].id, { product, variant: product.variants[0], qty: 1 });
    }
    const lines = [...chosen.values()];
    const subtotal = lines.reduce((s, l) => s + l.variant.price * l.qty, 0);

    const prior = customerOrderCount.get(customer.id) ?? 0;
    let coupon: (typeof coupons)[keyof typeof coupons] | null = null;
    let discount = 0;
    if (prior === 0 && chance(0.4)) {
      coupon = coupons.WELCOME10;
      discount = Math.min(500, round2(subtotal * 0.1));
    } else if (subtotal >= 1499 && chance(0.25)) {
      coupon = coupons.FLAT200;
      discount = 200;
    }
    const merchandise = subtotal - discount;
    const method: PaymentMethod = chance(0.35) ? "COD" : "RAZORPAY";
    const shippingFee = merchandise >= 999 ? 0 : 49;
    const codFee = method === "COD" ? 49 : 0;
    const giftWrap = chance(0.12);
    const giftWrapFee = giftWrap ? 49 : 0;
    const total = round2(merchandise + shippingFee + codFee + giftWrapFee);
    const taxTotal = round2((merchandise * 3) / 103);

    let status: OrderStatus;
    if (age <= 1) status = method === "RAZORPAY" && k % 6 === 0 ? "PENDING" : "CONFIRMED";
    else if (age <= 3) status = pick(["PACKED", "SHIPPED", "CONFIRMED"] as const);
    else if (age <= 6) status = pick(["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERED"] as const);
    else {
      const r = rng();
      status = r < 0.08 ? "CANCELLED" : r < 0.13 ? "RETURNED" : r < 0.16 && age < 30 ? "RETURN_REQUESTED" : "DELIVERED";
    }

    let orderNumber = "";
    do {
      orderNumber = `AJ${String(placedAt.getFullYear()).slice(2)}${String(placedAt.getMonth() + 1).padStart(2, "0")}${String(placedAt.getDate()).padStart(2, "0")}${digits(4)}`;
    } while (usedNumbers.has(orderNumber));
    usedNumbers.add(orderNumber);

    const confirmedAt = status === "PENDING" ? null : hoursAfter(placedAt, 0.2);
    const packedAt = hoursAfter(placedAt, int(6, 20));
    const shippedAt = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status) ? hoursAfter(placedAt, int(22, 40)) : null;
    const deliveredAt = ["DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status) ? hoursAfter(placedAt, int(70, 140)) : null;
    const cancelledAt = status === "CANCELLED" ? hoursAfter(placedAt, int(2, 20)) : null;

    const paid = method === "RAZORPAY" ? status !== "PENDING" : ["DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status);
    const refunded = paid && (status === "RETURNED" || status === "CANCELLED");
    const loyaltyEarned = customer.registered && status === "DELIVERED" ? Math.floor(total / 100) : 0;

    let invoiceNumber: string | null = null;
    if (status !== "PENDING") {
      invoiceSeq++;
      const fyStart = placedAt.getMonth() >= 3 ? placedAt.getFullYear() : placedAt.getFullYear() - 1;
      invoiceNumber = `AJ/INV/${fyStart}-${String(fyStart + 1).slice(2)}/${String(invoiceSeq).padStart(6, "0")}`;
    }

    // Allocate the order discount across lines proportionally (for GST invoices).
    let remainingDiscount = discount;
    const itemData = lines.map((l, idx) => {
      const gross = l.variant.price * l.qty;
      const share = idx === lines.length - 1 ? remainingDiscount : round2((gross / subtotal) * discount);
      remainingDiscount = round2(remainingDiscount - share);
      const lineTotal = round2(gross - share);
      return {
        productId: l.product.id,
        variantId: l.variant.id,
        name: l.product.name,
        sku: l.variant.sku,
        variantTitle: l.variant.title === "Default" ? null : l.variant.title,
        image: l.product.image,
        unitPrice: l.variant.price,
        quantity: l.qty,
        discount: share,
        taxRate: 3,
        taxAmount: round2((lineTotal * 3) / 103),
        total: lineTotal,
        refundedQty: status === "RETURNED" ? l.qty : 0,
      };
    });

    const events: Prisma.OrderEventCreateWithoutOrderInput[] = [{ status: "PENDING", title: "Order placed", note: method === "COD" ? "Cash on Delivery" : "Online payment", createdAt: placedAt }];
    if (method === "RAZORPAY" && status !== "PENDING") events.push({ title: "Payment received", note: "Razorpay", createdAt: hoursAfter(placedAt, 0.05) });
    if (confirmedAt) events.push({ status: "CONFIRMED", title: "Order confirmed", createdAt: confirmedAt });
    if (["PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status)) events.push({ status: "PACKED", title: "Packed", createdAt: packedAt });
    if (shippedAt) events.push({ status: "SHIPPED", title: "Shipped", createdAt: shippedAt });
    if (["OUT_FOR_DELIVERY", "DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status) && shippedAt) events.push({ status: "OUT_FOR_DELIVERY", title: "Out for delivery", createdAt: hoursAfter(shippedAt, 40) });
    if (deliveredAt) events.push({ status: "DELIVERED", title: "Delivered", createdAt: deliveredAt });
    if (status === "RETURN_REQUESTED" && deliveredAt) events.push({ status: "RETURN_REQUESTED", title: "Return requested", note: "Size doesn't fit", createdAt: hoursAfter(deliveredAt, 30) });
    if (status === "RETURNED" && deliveredAt) {
      events.push({ status: "RETURN_REQUESTED", title: "Return requested", note: "Changed my mind", createdAt: hoursAfter(deliveredAt, 24) });
      events.push({ status: "RETURNED", title: "Returned", note: "Item received back in warehouse", createdAt: hoursAfter(deliveredAt, 120) });
    }
    if (cancelledAt) events.push({ status: "CANCELLED", title: "Order cancelled", note: "Customer requested cancellation", createdAt: cancelledAt });
    if (refunded) events.push({ title: "Order refunded", note: `₹${total}`, createdAt: hoursAfter(cancelledAt ?? deliveredAt ?? placedAt, 26) });

    const addr = customer.address;
    const order = await prisma.order.create({
      data: {
        orderNumber,
        customerId: customer.id,
        email: customer.email,
        phone: customer.phone ?? addr.phone,
        customerName: customer.name,
        status,
        paymentStatus: refunded ? "REFUNDED" : paid ? "PAID" : "PENDING",
        paymentMethod: method,
        source: k % 17 === 0 ? "ADMIN" : "WEB",
        subtotal,
        discount,
        shippingFee,
        codFee,
        giftWrapFee,
        taxTotal,
        total,
        refundedAmount: refunded ? total : 0,
        couponCode: coupon?.code,
        shippingAddress: { name: customer.name, phone: addr.phone, line1: addr.line1, city: addr.city, state: addr.state, pincode: addr.pincode, country: "India" },
        shippingMethod: "Standard",
        giftWrap,
        giftMessage: giftWrap ? "Happy birthday! With love ❤" : null,
        loyaltyEarned,
        invoiceNumber,
        cancelReason: status === "CANCELLED" ? "Customer requested cancellation" : null,
        placedAt,
        createdAt: placedAt,
        confirmedAt,
        shippedAt,
        deliveredAt,
        cancelledAt,
        items: { create: itemData },
        events: { create: events },
      },
    });
    customerOrderCount.set(customer.id, prior + 1);

    // Payments, refunds & settlements
    if (method === "RAZORPAY") {
      const capturedAt = hoursAfter(placedAt, 0.05);
      const payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: "RAZORPAY",
          method: pick(["upi", "upi", "card", "netbanking", "wallet"]),
          amount: total,
          status: status === "PENDING" ? "CREATED" : refunded ? "REFUNDED" : "CAPTURED",
          providerOrderId: `order_mock_${digits(10)}`,
          providerPaymentId: status === "PENDING" ? null : `pay_mock_${digits(10)}`,
          fee: status === "PENDING" ? null : round2(total * 0.02),
          tax: status === "PENDING" ? null : round2(total * 0.02 * 0.18),
          capturedAt: status === "PENDING" ? null : capturedAt,
          createdAt: placedAt,
        },
      });
      if (status !== "PENDING" && age > 3) paymentsForSettlement.push({ id: payment.id, amount: total, capturedAt });
      if (refunded) {
        await prisma.refund.create({
          data: { orderId: order.id, paymentId: payment.id, amount: total, reason: status === "CANCELLED" ? "Order cancelled" : "Return received", status: "PROCESSED", providerRefundId: `rfnd_mock_${digits(8)}`, restock: true, processedBy: "Ananta Admin", processedAt: hoursAfter(cancelledAt ?? deliveredAt ?? placedAt, 26), createdAt: hoursAfter(cancelledAt ?? deliveredAt ?? placedAt, 26) },
        });
      }
    } else {
      await prisma.payment.create({
        data: { orderId: order.id, provider: "COD", method: "cod", amount: total, status: paid ? "CAPTURED" : "CREATED", capturedAt: paid ? deliveredAt : null, createdAt: placedAt },
      });
    }

    // Shipments
    if (["PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status)) {
      const shipStatus: ShipmentStatus =
        status === "PACKED" ? "CREATED" : status === "SHIPPED" ? "IN_TRANSIT" : status === "OUT_FOR_DELIVERY" ? "OUT_FOR_DELIVERY" : status === "RETURNED" ? "DELIVERED" : "DELIVERED";
      const useNdr = status === "OUT_FOR_DELIVERY" && !ndrCreated;
      const shipEvents: Prisma.ShipmentEventCreateWithoutShipmentInput[] = [{ status: "CREATED", note: "Shipment created", occurredAt: packedAt }];
      if (shippedAt) {
        shipEvents.push({ status: "PICKED_UP", location: "Surat Hub", note: "Picked up by courier", occurredAt: shippedAt });
        shipEvents.push({ status: "IN_TRANSIT", location: "Ahmedabad Gateway", note: "In transit", occurredAt: hoursAfter(shippedAt, 14) });
      }
      if (["OUT_FOR_DELIVERY", "DELIVERED", "RETURN_REQUESTED", "RETURNED"].includes(status) && shippedAt) {
        shipEvents.push({ status: "OUT_FOR_DELIVERY", location: addr.city, note: "Out for delivery", occurredAt: hoursAfter(shippedAt, 40) });
      }
      if (deliveredAt) shipEvents.push({ status: "DELIVERED", location: addr.city, note: "Delivered to customer", occurredAt: deliveredAt });
      if (useNdr && shippedAt) shipEvents.push({ status: "NDR", location: addr.city, note: "Customer not available", occurredAt: hoursAfter(shippedAt, 46) });
      const shipment = await prisma.shipment.create({
        data: {
          orderId: order.id,
          partnerId: manualPartner.id,
          awb: `AJ${digits(10)}`,
          courierName: pick(COURIERS),
          status: useNdr ? "NDR" : shipStatus,
          weight: 50,
          length: 12,
          width: 10,
          height: 5,
          shippingCost: pick([42, 48, 55, 61]),
          shippedAt,
          deliveredAt,
          createdAt: packedAt,
          events: { create: shipEvents },
        },
      });
      if (useNdr) {
        ndrCreated = true;
        await prisma.ndrCase.create({ data: { shipmentId: shipment.id, reason: "Customer not available / phone switched off", attempts: 1 } });
      }
    }

    if (coupon) {
      await prisma.couponRedemption.create({ data: { couponId: coupon.id, customerId: customer.id, orderId: order.id, discount, createdAt: placedAt } });
      await prisma.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
    }
    if (status !== "CANCELLED" && status !== "PENDING") {
      for (const l of lines) sold.set(l.product.id, (sold.get(l.product.id) ?? 0) + l.qty);
    }
    if (loyaltyEarned) {
      await prisma.loyaltyTransaction.create({ data: { customerId: customer.id, type: "EARN", points: loyaltyEarned, orderId: order.id, note: `Order ${orderNumber}`, createdAt: deliveredAt ?? placedAt } });
      customer.points += loyaltyEarned;
    }
    if (status === "DELIVERED" && deliveredAt) {
      for (const l of lines) deliveredPurchases.push({ customerId: customer.id, name: customer.name, productId: l.product.id, at: deliveredAt });
    }
  }
  await prisma.$executeRawUnsafe(`SELECT setval('invoice_seq', ${Math.max(1, invoiceSeq)}, ${invoiceSeq > 0})`);

  for (const [productId, qty] of sold) await prisma.product.update({ where: { id: productId }, data: { soldCount: qty + int(20, 180) } });
  for (const c of customers) {
    await prisma.customer.update({ where: { id: c.id }, data: { loyaltyPoints: c.points } });
  }
  // VIP group for the biggest spenders
  const top = await prisma.order.groupBy({ by: ["customerId"], where: { status: { notIn: ["CANCELLED", "PENDING"] } }, _sum: { total: true }, orderBy: { _sum: { total: "desc" } }, take: 3 });
  await prisma.customer.updateMany({ where: { id: { in: top.map((t) => t.customerId!).filter(Boolean) } }, data: { groupId: vip.id, tags: ["vip"] } });

  // Weekly Razorpay settlements (T+2) for older captured payments
  const byWeek = new Map<string, typeof paymentsForSettlement>();
  for (const p of paymentsForSettlement) {
    const d = new Date(p.capturedAt);
    d.setDate(d.getDate() - d.getDay());
    const key = d.toISOString().slice(0, 10);
    byWeek.set(key, [...(byWeek.get(key) ?? []), p]);
  }
  for (const [week, list] of byWeek) {
    const settledAt = new Date(new Date(week).getTime() + 9 * DAY);
    if (settledAt > now) continue;
    const gross = list.reduce((s, p) => s + p.amount, 0);
    const fees = round2(gross * 0.02);
    const tax = round2(fees * 0.18);
    const s = await prisma.settlement.create({
      data: { settlementId: `setl_mock_${week.replace(/-/g, "")}`, amount: round2(gross - fees - tax), fees, tax, utr: `UTR${digits(12)}`, settledAt },
    });
    await prisma.payment.updateMany({ where: { id: { in: list.map((p) => p.id) } }, data: { settlementId: s.id } });
  }
  console.log(`  ${ORDER_COUNT} orders with payments, shipments & settlements`);

  // ── Reviews ────────────────────────────────────────────────────────────────
  const REVIEWER_NAMES = ["Shreya", "Nikita", "Payal", "Harshita", "Anjali", "Rhea", "Mansi", "Aarti", "Komal", "Vidya", "Rohan", "Sakshi"];
  let pendingLeft = 4;
  for (const p of products) {
    const verified = deliveredPurchases.filter((d) => d.productId === p.id).slice(0, 3);
    const extra = int(2, 5);
    const entries = [
      ...verified.map((v) => ({ name: v.name, customerId: v.customerId, verified: true, at: hoursAfter(v.at, int(24, 200)) })),
      ...Array.from({ length: extra }, () => ({ name: `${pick(REVIEWER_NAMES)} ${pick(["S.", "K.", "M.", "P.", "R."])}`, customerId: null as string | null, verified: false, at: daysAgo(int(3, 120)) })),
    ];
    for (const e of entries) {
      const snippet = pick(REVIEW_SNIPPETS);
      const status = pendingLeft > 0 && chance(0.08) ? "PENDING" : snippet.rating <= 2 && chance(0.3) ? "REJECTED" : "APPROVED";
      if (status === "PENDING") pendingLeft--;
      await prisma.review.create({
        data: {
          productId: p.id,
          customerId: e.customerId,
          name: e.name,
          rating: snippet.rating,
          title: snippet.title,
          body: snippet.body,
          status,
          isVerifiedPurchase: e.verified,
          helpfulCount: int(0, 24),
          adminReply: snippet.rating <= 3 && status === "APPROVED" ? "Thank you for the feedback! Our care team has reached out to help." : null,
          createdAt: e.at > now ? now : e.at,
        },
      });
    }
    await recomputeRating(p.id);
  }
  console.log("  reviews");

  // ── Engagement: carts, wishlist, newsletter, traffic, inbox ───────────────
  for (const [idx, c] of customers.slice(3, 6).entries()) {
    const items = products.slice(idx * 3, idx * 3 + 2);
    await prisma.cart.create({
      data: {
        customerId: c.id,
        updatedAt: daysAgo(0, 3 + idx * 9),
        items: { create: items.map((p) => ({ variantId: p.variants[0].id, quantity: 1 })) },
      },
    });
  }
  await prisma.wishlistItem.createMany({ data: products.slice(0, 5).map((p) => ({ customerId: customers[0].id, productId: p.id })) });

  await prisma.newsletterSubscriber.createMany({
    data: [
      ...customers.slice(0, 8).map((c) => ({ email: c.email, name: c.name, source: "checkout", createdAt: c.createdAt })),
      ...Array.from({ length: 22 }, (_, i) => ({ email: `subscriber${i + 1}@example.com`, source: pick(["footer", "popup", "blog"]), status: i % 9 === 0 ? ("UNSUBSCRIBED" as const) : ("SUBSCRIBED" as const), createdAt: daysAgo(int(1, 120)) })),
    ],
  });

  const traffic: Prisma.DailyTrafficCreateManyInput[] = [];
  for (let d = 120; d >= 0; d--) {
    const date = daysAgo(d);
    const weekend = [0, 6].includes(date.getDay());
    const visits = Math.round((260 + (120 - d) * 2.2 + (weekend ? 140 : 0)) * (0.8 + rng() * 0.4));
    traffic.push({
      date: new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())),
      visits,
      productViews: Math.round(visits * (2.4 + rng())),
      addToCarts: Math.round(visits * (0.07 + rng() * 0.03)),
      checkouts: Math.round(visits * (0.025 + rng() * 0.015)),
    });
  }
  await prisma.dailyTraffic.createMany({ data: traffic });

  await prisma.inquiry.createMany({
    data: [
      { name: "Sonal Agarwal", email: "sonal@example.com", phone: "9811122233", subject: "Bulk order for wedding favours", message: "We need 40 silver pendants for wedding return gifts. Can you share pricing?", createdAt: daysAgo(1) },
      { name: "Farhan Ali", email: "farhan@example.com", subject: "Ring resizing", message: "Can I get my ring resized from 12 to 14?", isRead: true, createdAt: daysAgo(6) },
      { name: "Lakshmi R", email: "lakshmi@example.com", phone: "9822233344", subject: "Store visit", message: "Do you have a store in Bengaluru where I can try the lab-grown diamond rings?", createdAt: daysAgo(0, 5) },
    ],
  });

  await prisma.notification.createMany({
    data: [
      { type: "ORDER_PLACED", title: "New order received", body: "A new order was placed on the storefront.", link: "/dashboard/orders", createdAt: daysAgo(0, 1) },
      { type: "LOW_STOCK", title: "Low stock alert", body: "Some SKUs have reached their low stock threshold.", link: "/dashboard/inventory/low-stock", createdAt: daysAgo(0, 4) },
      { type: "REVIEW", title: "New reviews awaiting moderation", body: "Customers left new product reviews.", link: "/dashboard/reviews", createdAt: daysAgo(1) },
      { type: "NDR", title: "NDR raised on a shipment", body: "Delivery attempt failed — action needed.", link: "/dashboard/shipping/ndr", createdAt: daysAgo(1, 6) },
      { type: "SYSTEM", title: "Welcome to Ananta Admin", body: "Your store is ready. Configure payments and shipping under Settings.", link: "/dashboard/settings", readAt: daysAgo(2), createdAt: daysAgo(3) },
    ],
  });
  await prisma.activityLog.createMany({
    data: [
      { adminId: admin.id, action: "settings.update", entity: "Setting", entityId: "store", summary: "Updated store settings", createdAt: daysAgo(3) },
      { adminId: admin.id, action: "product.create", entity: "Product", entityId: products[0].id, summary: products[0].name, createdAt: daysAgo(2) },
      { adminId: admin.id, action: "coupon.create", entity: "Coupon", entityId: coupons.FLAT200.id, summary: "FLAT200", createdAt: daysAgo(1) },
    ],
  });

  console.log(`  ${await registerSeedMedia(SEED_DIR)} media library files`);

  console.log("\n✦ Done!");
  console.log(`  Admin login     → ${adminEmail} / ${adminPassword}`);
  console.log("  Manager / Staff → manager@anantajewellery.in / Manager@123 · staff@anantajewellery.in / Staff@123");
  console.log("  Customer login  → priya@example.com / Customer@123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
