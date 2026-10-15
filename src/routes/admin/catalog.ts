import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { Prisma, type ProductStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, pageArgs, pageMeta, param, parse, queryString } from "../../lib/http";
import { requirePerm } from "../../middleware/auth";
import { logActivity } from "../../lib/audit";
import { registerCrud } from "../../lib/crud";
import { adjustStock, defaultWarehouseId } from "../../lib/inventory";
import { recomputeRating } from "../../lib/reviews";
import { parseCsv, sendExport, toCsv, type Column } from "../../lib/export";
import { num, serialize, slugify } from "../../lib/utils";
import { richText, sanitizeRichText } from "../../lib/html";

const router = Router();
const read = requirePerm("products.read");
const write = requirePerm("products.write");

const money = z.coerce.number().min(0);
/** Optional amount where null / "" mean "not set" (z.coerce would turn them into 0). */
const optMoney = z.preprocess((v) => (v === "" || v === null ? null : v), z.coerce.number().min(0).nullable()).optional();

const variantInput = z.object({
  id: z.string().optional(),
  sku: z.string().trim().min(1).max(60),
  barcode: z.string().max(60).optional().nullable(),
  title: z.string().trim().min(1).max(120),
  size: z.string().max(30).optional().nullable(),
  colour: z.string().max(40).optional().nullable(),
  price: optMoney,
  compareAtPrice: optMoney,
  weight: optMoney,
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  /** Initial stock in the default warehouse (new variants only) */
  stock: z.coerce.number().int().min(0).optional(),
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
});

const imageInput = z.object({
  url: z.string().min(1),
  alt: z.string().max(200).optional().nullable(),
  variantSku: z.string().optional().nullable(),
});

const productInput = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().max(200).optional(),
  sku: z.string().trim().min(1).max(60),
  shortDescription: z.string().max(500).optional().nullable(),
  description: richText(20000).optional().nullable(),
  categoryId: z.string().optional().nullable(),
  collectionIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("DRAFT"),
  material: z.string().max(60).optional().nullable(),
  colour: z.string().max(40).optional().nullable(),
  stone: z.string().max(60).optional().nullable(),
  occasions: z.array(z.string()).default([]),
  gender: z.string().default("Women"),
  price: money,
  compareAtPrice: optMoney,
  costPrice: optMoney,
  taxRate: z.coerce.number().min(0).max(28).default(3),
  hsnCode: z.string().max(12).optional().nullable(),
  weight: optMoney,
  length: optMoney,
  width: optMoney,
  height: optMoney,
  barcode: z.string().max(60).optional().nullable(),
  sizeGuide: z.string().max(20).optional().nullable(),
  careInstructions: z.string().max(2000).optional().nullable(),
  warranty: z.string().max(300).optional().nullable(),
  hasCertificate: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  isBestseller: z.boolean().default(false),
  isNewArrival: z.boolean().default(false),
  isGiftable: z.boolean().default(true),
  seoTitle: z.string().max(200).optional().nullable(),
  seoDescription: z.string().max(400).optional().nullable(),
  images: z.array(imageInput).max(20).default([]),
  variants: z.array(variantInput).max(60).default([]),
});

type ProductInput = z.infer<typeof productInput>;

function productData(body: ProductInput) {
  const { collectionIds: _c, tagIds: _t, images: _i, variants: _v, ...rest } = body;
  return { ...rest, slug: body.slug?.trim() || slugify(body.name) };
}

/** Make sure there is exactly one default variant (creates "Default" when none given). */
function normaliseVariants(body: ProductInput) {
  const variants = body.variants.length
    ? body.variants
    : [{ sku: body.sku, title: "Default", isDefault: true, isActive: true } as z.infer<typeof variantInput>];
  const skus = new Set<string>();
  for (const v of variants) {
    if (skus.has(v.sku)) throw badRequest(`Duplicate variant SKU ${v.sku}`);
    skus.add(v.sku);
  }
  if (!variants.some((v) => v.isDefault)) variants[0].isDefault = true;
  let seen = false;
  return variants.map((v, i) => {
    const isDefault = !!v.isDefault && !seen;
    if (isDefault) seen = true;
    return { ...v, isDefault, sortOrder: i };
  });
}

const adminInclude = {
  images: { orderBy: { sortOrder: "asc" } },
  category: { select: { id: true, name: true, slug: true } },
  collections: { select: { id: true, name: true } },
  tags: { select: { id: true, name: true } },
  variants: {
    orderBy: { sortOrder: "asc" },
    include: { inventory: { include: { warehouse: { select: { id: true, name: true, code: true } } } } },
  },
} satisfies Prisma.ProductInclude;

function presentAdminProduct(p: Prisma.ProductGetPayload<{ include: typeof adminInclude }>) {
  return serialize({
    ...p,
    collectionIds: p.collections.map((c) => c.id),
    tagIds: p.tags.map((t) => t.id),
    images: p.images.map((i) => ({ ...i, variantSku: p.variants.find((v) => v.id === i.variantId)?.sku ?? null })),
    variants: p.variants.map((v) => ({
      ...v,
      stock: v.inventory.reduce((s, l) => s + l.quantity, 0),
      available: v.inventory.reduce((s, l) => s + Math.max(0, l.quantity - l.reserved), 0),
      lowStockThreshold: v.inventory[0]?.lowStockThreshold ?? 5,
    })),
    totalStock: p.variants.reduce((s, v) => s + v.inventory.reduce((a, l) => a + l.quantity, 0), 0),
  });
}

// ───────────────────────────────── Products ──────────────────────────────────

router.get("/products", read, async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const q = queryString(req, "q");
  const status = queryString(req, "status");
  const categoryId = queryString(req, "categoryId");
  const collectionId = queryString(req, "collectionId");
  const flag = queryString(req, "flag");
  const where: Prisma.ProductWhereInput = {
    ...(status ? { status: status as ProductStatus } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(collectionId ? { collections: { some: { id: collectionId } } } : {}),
    ...(flag === "bestseller" ? { isBestseller: true } : flag === "new" ? { isNewArrival: true } : flag === "featured" ? { isFeatured: true } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { sku: { contains: q, mode: "insensitive" } },
            { variants: { some: { sku: { contains: q, mode: "insensitive" } } } },
            { barcode: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const sortKey = queryString(req, "sort") ?? "newest";
  const orderBy: Prisma.ProductOrderByWithRelationInput =
    sortKey === "name" ? { name: "asc" } : sortKey === "price" ? { price: "desc" } : sortKey === "sold" ? { soldCount: "desc" } : { createdAt: "desc" };

  const stockFilter = queryString(req, "stock");
  let rows = await prisma.product.findMany({
    where,
    orderBy,
    ...(stockFilter ? {} : { skip, take }),
    include: {
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
      category: { select: { name: true } },
      variants: { select: { id: true, inventory: { select: { quantity: true, reserved: true, lowStockThreshold: true } } } },
    },
  });
  const withStock = rows.map((p) => {
    const stock = p.variants.reduce((s, v) => s + v.inventory.reduce((a, l) => a + Math.max(0, l.quantity - l.reserved), 0), 0);
    const threshold = p.variants.reduce((s, v) => s + (v.inventory[0]?.lowStockThreshold ?? 5), 0);
    return { p, stock, low: stock > 0 && stock <= threshold };
  });
  let filtered = withStock;
  if (stockFilter === "out") filtered = withStock.filter((r) => r.stock <= 0);
  if (stockFilter === "low") filtered = withStock.filter((r) => r.low);
  if (stockFilter === "in") filtered = withStock.filter((r) => r.stock > 0);
  const total = stockFilter ? filtered.length : await prisma.product.count({ where });
  if (stockFilter) filtered = filtered.slice(skip, skip + take);
  rows = filtered.map((r) => r.p);

  res.json(
    serialize({
      items: filtered.map(({ p, stock, low }) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        sku: p.sku,
        status: p.status,
        price: p.price,
        compareAtPrice: p.compareAtPrice,
        image: p.images[0]?.url ?? null,
        category: p.category?.name ?? null,
        variantCount: p.variants.length,
        stock,
        stockState: stock <= 0 ? "OUT" : low ? "LOW" : "IN",
        isBestseller: p.isBestseller,
        isNewArrival: p.isNewArrival,
        isFeatured: p.isFeatured,
        soldCount: p.soldCount,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        updatedAt: p.updatedAt,
      })),
      meta: pageMeta(total, page, limit),
    }),
  );
});

// Export / import must be registered before "/products/:id"
const EXPORT_COLUMNS: Column<Record<string, unknown>>[] = [
  "name", "slug", "sku", "status", "category", "material", "colour", "stone", "occasions", "gender", "price", "compareAtPrice",
  "costPrice", "taxRate", "weight", "isBestseller", "isNewArrival", "isFeatured", "tags", "images", "shortDescription", "description",
  "variantSku", "variantTitle", "size", "variantColour", "variantPrice", "variantCompareAtPrice", "barcode", "stock",
].map((k) => ({ key: k, label: k }));

router.get("/products/export", read, async (req, res) => {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: "desc" },
    include: { category: true, tags: true, images: { orderBy: { sortOrder: "asc" } }, variants: { include: { inventory: true }, orderBy: { sortOrder: "asc" } } },
  });
  const rows = products.flatMap((p) =>
    p.variants.map((v) => ({
      name: p.name,
      slug: p.slug,
      sku: p.sku,
      status: p.status,
      category: p.category?.slug ?? "",
      material: p.material,
      colour: p.colour,
      stone: p.stone,
      occasions: p.occasions.join("|"),
      gender: p.gender,
      price: num(p.price),
      compareAtPrice: num(p.compareAtPrice) || "",
      costPrice: num(p.costPrice) || "",
      taxRate: num(p.taxRate),
      weight: num(p.weight) || "",
      isBestseller: p.isBestseller,
      isNewArrival: p.isNewArrival,
      isFeatured: p.isFeatured,
      tags: p.tags.map((t) => t.slug).join("|"),
      images: p.images.map((i) => i.url).join("|"),
      shortDescription: p.shortDescription,
      description: p.description,
      variantSku: v.sku,
      variantTitle: v.title,
      size: v.size,
      variantColour: v.colour,
      variantPrice: v.price ? num(v.price) : "",
      variantCompareAtPrice: v.compareAtPrice ? num(v.compareAtPrice) : "",
      barcode: v.barcode,
      stock: v.inventory.reduce((s, l) => s + l.quantity, 0),
    })),
  );
  const format = queryString(req, "format") ?? "csv";
  await sendExport(res, format, "products", rows, EXPORT_COLUMNS);
});

router.get("/products/import-template", read, (_req, res) => {
  const sample = [
    {
      name: "Silver Heart Pendant",
      slug: "",
      sku: "AJ-PND-900",
      status: "ACTIVE",
      category: "pendants",
      material: "925 Silver",
      colour: "Silver",
      stone: "Zircon",
      occasions: "Daily Wear|Gifting",
      gender: "Women",
      price: 1999,
      compareAtPrice: 3499,
      costPrice: 700,
      taxRate: 3,
      weight: 4.2,
      isBestseller: "false",
      isNewArrival: "true",
      isFeatured: "false",
      tags: "gifts-for-her",
      images: "https://example.com/pendant-1.jpg|https://example.com/pendant-2.jpg",
      shortDescription: "A delicate heart pendant",
      description: "<p>Handcrafted in 925 silver.</p>",
      variantSku: "AJ-PND-900",
      variantTitle: "Default",
      size: "",
      variantColour: "",
      variantPrice: "",
      variantCompareAtPrice: "",
      barcode: "",
      stock: 25,
    },
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="product-import-template.csv"');
  res.send("\uFEFF" + toCsv(sample, EXPORT_COLUMNS));
});

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function rowsFromFile(file: Express.Multer.File) {
  if (/\.xlsx$/i.test(file.originalname)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const headers: string[] = [];
    ws.getRow(1).eachCell((c, i) => (headers[i] = String(c.value ?? "").trim()));
    const out: Record<string, string>[] = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = String(row.getCell(i).text ?? "").trim();
      });
      out.push(obj);
    });
    return out;
  }
  return parseCsv(file.buffer.toString("utf8"));
}

const truthy = (v?: string) => ["true", "1", "yes", "y"].includes((v ?? "").toLowerCase());
const toNum = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));

/** Bulk import / update products from CSV or XLSX (one row per variant, grouped by product SKU). */
router.post("/products/import", write, importUpload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("Upload a CSV or XLSX file");
  const rows = await rowsFromFile(req.file);
  if (!rows.length) throw badRequest("The file has no data rows");
  const groups = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const sku = r.sku?.trim();
    if (!sku) continue;
    groups.set(sku, [...(groups.get(sku) ?? []), r]);
  }
  const categories = await prisma.category.findMany({ select: { id: true, slug: true, name: true } });
  const tags = await prisma.tag.findMany({ select: { id: true, slug: true } });
  const warehouseId = await defaultWarehouseId();
  const result = { created: 0, updated: 0, variants: 0, errors: [] as { sku: string; error: string }[] };

  for (const [sku, group] of groups) {
    const first = group[0];
    try {
      const cat = categories.find((c) => c.slug === first.category || c.name.toLowerCase() === (first.category ?? "").toLowerCase());
      const price = toNum(first.price);
      if (!first.name || price === undefined || Number.isNaN(price)) throw new Error("name and price are required");
      const data = {
        name: first.name,
        slug: first.slug || slugify(first.name),
        status: (["DRAFT", "ACTIVE", "ARCHIVED"].includes(first.status) ? first.status : "DRAFT") as ProductStatus,
        categoryId: cat?.id ?? null,
        material: first.material || null,
        colour: first.colour || null,
        stone: first.stone || null,
        occasions: (first.occasions ?? "").split("|").map((s) => s.trim()).filter(Boolean),
        gender: first.gender || "Women",
        price,
        compareAtPrice: toNum(first.compareAtPrice) ?? null,
        costPrice: toNum(first.costPrice) ?? null,
        taxRate: toNum(first.taxRate) ?? 3,
        weight: toNum(first.weight) ?? null,
        isBestseller: truthy(first.isBestseller),
        isNewArrival: truthy(first.isNewArrival),
        isFeatured: truthy(first.isFeatured),
        shortDescription: first.shortDescription || null,
        description: first.description ? sanitizeRichText(first.description) : null,
      };
      const tagIds = (first.tags ?? "").split("|").map((s) => tags.find((t) => t.slug === s.trim())?.id).filter(Boolean) as string[];
      const images = (first.images ?? "").split("|").map((s) => s.trim()).filter(Boolean);
      const existing = await prisma.product.findUnique({ where: { sku } });
      await prisma.$transaction(async (tx) => {
        const product = existing
          ? await tx.product.update({ where: { id: existing.id }, data: { ...data, tags: { set: tagIds.map((id) => ({ id })) } } })
          : await tx.product.create({ data: { ...data, sku, tags: { connect: tagIds.map((id) => ({ id })) } } });
        if (images.length) {
          await tx.productImage.deleteMany({ where: { productId: product.id } });
          await tx.productImage.createMany({ data: images.map((url, i) => ({ productId: product.id, url, sortOrder: i, alt: data.name })) });
        }
        for (const [idx, r] of group.entries()) {
          const vSku = r.variantSku || sku;
          const vData = {
            title: r.variantTitle || (r.size ? `Size ${r.size}` : "Default"),
            size: r.size || null,
            colour: r.variantColour || null,
            price: toNum(r.variantPrice) ?? null,
            compareAtPrice: toNum(r.variantCompareAtPrice) ?? null,
            barcode: r.barcode || null,
            isDefault: idx === 0,
            sortOrder: idx,
          };
          const variant = await tx.productVariant.upsert({
            where: { sku: vSku },
            create: { ...vData, sku: vSku, productId: product.id },
            update: vData,
          });
          const stock = toNum(r.stock);
          if (stock !== undefined && !Number.isNaN(stock)) {
            await adjustStock(tx, { variantId: variant.id, warehouseId, set: stock, reason: "ADJUSTMENT", note: "CSV import", actor: req.admin?.name });
          }
          result.variants++;
        }
      });
      if (existing) result.updated++;
      else result.created++;
    } catch (e) {
      result.errors.push({ sku, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await logActivity(req, "product.import", "Product", null, `Imported ${result.created} new, ${result.updated} updated`, result);
  res.json(result);
});

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(["activate", "draft", "archive", "delete", "feature", "unfeature", "bestseller", "unbestseller", "new", "unnew", "category"]),
  categoryId: z.string().optional().nullable(),
});

router.post("/products/bulk", write, async (req, res) => {
  const { ids, action, categoryId } = parse(bulkSchema, req.body);
  const where = { id: { in: ids } };
  const map: Record<string, Prisma.ProductUpdateManyMutationInput> = {
    activate: { status: "ACTIVE", publishedAt: new Date() },
    draft: { status: "DRAFT" },
    archive: { status: "ARCHIVED" },
    feature: { isFeatured: true },
    unfeature: { isFeatured: false },
    bestseller: { isBestseller: true },
    unbestseller: { isBestseller: false },
    new: { isNewArrival: true },
    unnew: { isNewArrival: false },
  };
  let count = 0;
  if (action === "delete") {
    // Products with order history are archived instead of deleted to keep order records intact.
    const withOrders = await prisma.orderItem.findMany({ where: { productId: { in: ids } }, select: { productId: true }, distinct: ["productId"] });
    const keep = new Set(withOrders.map((o) => o.productId));
    const del = ids.filter((id) => !keep.has(id));
    count = (await prisma.product.deleteMany({ where: { id: { in: del } } })).count;
    if (keep.size) await prisma.product.updateMany({ where: { id: { in: [...keep] as string[] } }, data: { status: "ARCHIVED" } });
  } else if (action === "category") {
    count = (await prisma.product.updateMany({ where, data: { categoryId: categoryId ?? null } })).count;
  } else {
    count = (await prisma.product.updateMany({ where, data: map[action] })).count;
  }
  await logActivity(req, `product.bulk.${action}`, "Product", null, `${action} ${ids.length} products`);
  res.json({ ok: true, count });
});

router.get("/products/:id", read, async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: param(req, "id") }, include: adminInclude });
  if (!p) throw notFound("Product not found");
  res.json(presentAdminProduct(p));
});

router.post("/products", write, async (req, res) => {
  const body = parse(productInput, req.body);
  const variants = normaliseVariants(body);
  const warehouseId = await defaultWarehouseId();
  const created = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...productData(body),
        publishedAt: body.status === "ACTIVE" ? new Date() : undefined,
        collections: body.collectionIds?.length ? { connect: body.collectionIds.map((id) => ({ id })) } : undefined,
        tags: body.tagIds?.length ? { connect: body.tagIds.map((id) => ({ id })) } : undefined,
      },
    });
    const skuToId = new Map<string, string>();
    for (const v of variants) {
      const { id: _id, stock, lowStockThreshold, ...vd } = v;
      const variant = await tx.productVariant.create({ data: { ...vd, productId: product.id } });
      skuToId.set(v.sku, variant.id);
      await tx.inventoryLevel.create({
        data: { variantId: variant.id, warehouseId, quantity: 0, lowStockThreshold: lowStockThreshold ?? 5 },
      });
      if (stock) await adjustStock(tx, { variantId: variant.id, warehouseId, change: stock, reason: "RESTOCK", note: "Opening stock", actor: req.admin?.name });
    }
    await tx.productImage.createMany({
      data: body.images.map((img, i) => ({
        productId: product.id,
        url: img.url,
        alt: img.alt ?? body.name,
        sortOrder: i,
        variantId: img.variantSku ? skuToId.get(img.variantSku) : undefined,
      })),
    });
    return product;
  });
  await logActivity(req, "product.create", "Product", created.id, created.name);
  const full = await prisma.product.findUniqueOrThrow({ where: { id: created.id }, include: adminInclude });
  res.status(201).json(presentAdminProduct(full));
});

router.patch("/products/:id", write, async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.product.findUnique({ where: { id }, include: { variants: true } });
  if (!existing) throw notFound("Product not found");
  const body = parse(productInput, req.body);
  const variants = normaliseVariants(body);
  const warehouseId = await defaultWarehouseId();

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        ...productData(body),
        publishedAt: body.status === "ACTIVE" && !existing.publishedAt ? new Date() : undefined,
        collections: { set: (body.collectionIds ?? []).map((cid) => ({ id: cid })) },
        tags: { set: (body.tagIds ?? []).map((tid) => ({ id: tid })) },
      },
    });

    const keepIds = new Set<string>();
    const skuToId = new Map<string, string>();
    for (const v of variants) {
      const { id: vid, stock, lowStockThreshold, ...vd } = v;
      const match = existing.variants.find((ev) => ev.id === vid) ?? existing.variants.find((ev) => ev.sku === v.sku);
      if (match) {
        await tx.productVariant.update({ where: { id: match.id }, data: { ...vd, isActive: vd.isActive ?? true } });
        if (lowStockThreshold !== undefined) {
          await tx.inventoryLevel.updateMany({ where: { variantId: match.id }, data: { lowStockThreshold } });
        }
        keepIds.add(match.id);
        skuToId.set(v.sku, match.id);
      } else {
        const created = await tx.productVariant.create({ data: { ...vd, productId: id } });
        await tx.inventoryLevel.create({ data: { variantId: created.id, warehouseId, quantity: 0, lowStockThreshold: lowStockThreshold ?? 5 } });
        if (stock) await adjustStock(tx, { variantId: created.id, warehouseId, change: stock, reason: "RESTOCK", note: "Opening stock", actor: req.admin?.name });
        keepIds.add(created.id);
        skuToId.set(v.sku, created.id);
      }
    }
    // Removed variants: delete when unused, otherwise deactivate to keep order history.
    for (const ev of existing.variants.filter((v) => !keepIds.has(v.id))) {
      const used = await tx.orderItem.count({ where: { variantId: ev.id } });
      if (used) await tx.productVariant.update({ where: { id: ev.id }, data: { isActive: false, isDefault: false } });
      else await tx.productVariant.delete({ where: { id: ev.id } });
    }

    await tx.productImage.deleteMany({ where: { productId: id } });
    await tx.productImage.createMany({
      data: body.images.map((img, i) => ({
        productId: id,
        url: img.url,
        alt: img.alt ?? body.name,
        sortOrder: i,
        variantId: img.variantSku ? skuToId.get(img.variantSku) : undefined,
      })),
    });
  });
  await logActivity(req, "product.update", "Product", id, body.name);
  const full = await prisma.product.findUniqueOrThrow({ where: { id }, include: adminInclude });
  res.json(presentAdminProduct(full));
});

router.post("/products/:id/duplicate", write, async (req, res) => {
  const src = await prisma.product.findUnique({ where: { id: param(req, "id") }, include: { images: true, variants: true, collections: true, tags: true } });
  if (!src) throw notFound("Product not found");
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  const copy = await prisma.$transaction(async (tx) => {
    const {
      id: _id, createdAt: _c, updatedAt: _u, images, variants, collections, tags, slug, sku, name,
      soldCount: _s, viewCount: _v, ratingAvg: _r, ratingCount: _rc, publishedAt: _p, ...rest
    } = src;
    const p = await tx.product.create({
      data: {
        ...rest,
        name: `${name} (Copy)`,
        slug: `${slug}-copy-${suffix.toLowerCase()}`,
        sku: `${sku}-${suffix}`,
        status: "DRAFT",
        collections: { connect: collections.map((c) => ({ id: c.id })) },
        tags: { connect: tags.map((t) => ({ id: t.id })) },
        images: { create: images.map((i) => ({ url: i.url, alt: i.alt, sortOrder: i.sortOrder })) },
      },
    });
    const warehouseId = await defaultWarehouseId(tx);
    for (const v of variants) {
      const { id: _vid, productId: _pid, createdAt: _vc, updatedAt: _vu, sku: vsku, ...vrest } = v;
      const nv = await tx.productVariant.create({ data: { ...vrest, sku: `${vsku}-${suffix}`, productId: p.id } });
      await tx.inventoryLevel.create({ data: { variantId: nv.id, warehouseId, quantity: 0 } });
    }
    return p;
  });
  await logActivity(req, "product.duplicate", "Product", copy.id, copy.name);
  res.status(201).json({ id: copy.id });
});

router.delete("/products/:id", write, async (req, res) => {
  const id = param(req, "id");
  const used = await prisma.orderItem.count({ where: { productId: id } });
  if (used) {
    await prisma.product.update({ where: { id }, data: { status: "ARCHIVED" } });
    await logActivity(req, "product.archive", "Product", id, "Archived (has orders)");
    res.json({ ok: true, archived: true, message: "Product has orders, so it was archived instead of deleted." });
    return;
  }
  await prisma.product.delete({ where: { id } });
  await logActivity(req, "product.delete", "Product", id);
  res.json({ ok: true });
});

// ─────────────────────────────── Categories ──────────────────────────────────

const categoryInput = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(100).optional(),
  description: z.string().max(2000).optional().nullable(),
  image: z.string().optional().nullable(),
  bannerImage: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
  showInMenu: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
  seoTitle: z.string().max(200).optional().nullable(),
  seoDescription: z.string().max(400).optional().nullable(),
});

registerCrud(router, "/categories", {
  model: prisma.category,
  area: "products",
  entity: "Category",
  createSchema: categoryInput,
  slugFrom: "name",
  orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  include: { parent: { select: { id: true, name: true } }, _count: { select: { products: true, children: true } } },
  searchFields: ["name", "slug"],
  transform: async (data, _req, id) => {
    if (id && data.parentId === id) throw badRequest("A category cannot be its own parent");
    if (data.slug === "") delete data.slug;
    return data;
  },
});

router.post("/categories/reorder", write, async (req, res) => {
  const items = parse(z.array(z.object({ id: z.string(), sortOrder: z.number().int(), parentId: z.string().nullable().optional() })), req.body);
  await prisma.$transaction(
    items.map((i) => prisma.category.update({ where: { id: i.id }, data: { sortOrder: i.sortOrder, ...(i.parentId !== undefined ? { parentId: i.parentId } : {}) } })),
  );
  res.json({ ok: true });
});

// ─────────────────────────────── Collections ─────────────────────────────────

const collectionInput = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(100).optional(),
  description: z.string().max(2000).optional().nullable(),
  image: z.string().optional().nullable(),
  bannerImage: z.string().optional().nullable(),
  type: z.enum(["CURATED", "OCCASION", "BOND", "CELEBRITY", "COLOUR", "GIFTING"]).default("CURATED"),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
  seoTitle: z.string().max(200).optional().nullable(),
  seoDescription: z.string().max(400).optional().nullable(),
});

router.get("/collections/:id/products", read, async (req, res) => {
  const rows = await prisma.product.findMany({
    where: { collections: { some: { id: param(req, "id") } } },
    select: { id: true, name: true, sku: true, status: true, price: true, images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } } },
  });
  res.json(serialize(rows));
});

router.put("/collections/:id/products", write, async (req, res) => {
  const { productIds } = parse(z.object({ productIds: z.array(z.string()).max(1000) }), req.body);
  await prisma.collection.update({ where: { id: param(req, "id") }, data: { products: { set: productIds.map((id) => ({ id })) } } });
  await logActivity(req, "collection.products", "Collection", param(req, "id"), `${productIds.length} products`);
  res.json({ ok: true, count: productIds.length });
});

registerCrud(router, "/collections", {
  model: prisma.collection,
  area: "products",
  entity: "Collection",
  createSchema: collectionInput,
  slugFrom: "name",
  orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
  include: { _count: { select: { products: true } } },
  searchFields: ["name", "slug"],
  listWhere: (req) => (queryString(req, "type") ? { type: queryString(req, "type") } : {}),
  transform: (data) => {
    if (data.slug === "") delete data.slug;
    return data;
  },
});

// ─────────────────────────────────── Tags ────────────────────────────────────

registerCrud(router, "/tags", {
  model: prisma.tag,
  area: "products",
  entity: "Tag",
  createSchema: z.object({ name: z.string().trim().min(1).max(60), slug: z.string().trim().max(80).optional(), group: z.string().max(40).default("general") }),
  slugFrom: "name",
  orderBy: [{ group: "asc" }, { name: "asc" }],
  include: { _count: { select: { products: true } } },
  searchFields: ["name", "slug", "group"],
  transform: (data) => {
    if (data.slug === "") delete data.slug;
    return data;
  },
});

// ───────────────────────────────── Reviews ───────────────────────────────────

router.get("/reviews", read, async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const status = queryString(req, "status");
  const rating = Number(queryString(req, "rating"));
  const q = queryString(req, "q");
  const where: Prisma.ReviewWhereInput = {
    ...(status ? { status: status as never } : {}),
    ...(rating ? { rating } : {}),
    ...(queryString(req, "productId") ? { productId: queryString(req, "productId") } : {}),
    ...(q ? { OR: [{ body: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { product: { name: { contains: q, mode: "insensitive" } } }] } : {}),
  };
  const [total, items, counts] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { product: { select: { id: true, name: true, slug: true, images: { take: 1, select: { url: true } } } } },
    }),
    prisma.review.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  res.json({
    items,
    meta: pageMeta(total, page, limit),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  });
});

router.patch("/reviews/:id", write, async (req, res) => {
  const body = parse(
    z.object({
      status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
      adminReply: z.string().max(2000).optional().nullable(),
      title: z.string().max(120).optional().nullable(),
      body: z.string().max(3000).optional(),
      rating: z.number().int().min(1).max(5).optional(),
    }),
    req.body,
  );
  const review = await prisma.review.update({ where: { id: param(req, "id") }, data: body });
  await recomputeRating(review.productId);
  await logActivity(req, "review.update", "Review", review.id, body.status ? `Marked ${body.status.toLowerCase()}` : "Edited review");
  res.json(review);
});

router.post("/reviews/bulk", write, async (req, res) => {
  const { ids, status } = parse(z.object({ ids: z.array(z.string()).min(1), status: z.enum(["APPROVED", "REJECTED", "PENDING"]).or(z.literal("DELETE")) }), req.body);
  const affected = await prisma.review.findMany({ where: { id: { in: ids } }, select: { productId: true } });
  if (status === "DELETE") await prisma.review.deleteMany({ where: { id: { in: ids } } });
  else await prisma.review.updateMany({ where: { id: { in: ids } }, data: { status } });
  for (const pid of new Set(affected.map((a) => a.productId))) await recomputeRating(pid);
  await logActivity(req, "review.bulk", "Review", null, `${status} ${ids.length} reviews`);
  res.json({ ok: true });
});

router.delete("/reviews/:id", write, async (req, res) => {
  const review = await prisma.review.delete({ where: { id: param(req, "id") } });
  await recomputeRating(review.productId);
  res.json({ ok: true });
});

export default router;
