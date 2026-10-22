import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { notFound, pageArgs, pageMeta, param, parse, queryList, queryString, badRequest } from "../lib/http";
import { liveFlashSaleWhere, productCardInclude, priceFor, toProductCard, variantStock } from "../lib/catalog";
import { ratingSummary } from "../lib/reviews";
import { requireCustomer } from "../middleware/auth";
import { num, serialize } from "../lib/utils";

const router = Router();

/** Category ids for a slug including all descendants (3 levels deep). */
async function categoryScope(slugs: string[]) {
  if (!slugs.length) return [];
  const roots = await prisma.category.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, children: { select: { id: true, children: { select: { id: true } } } } },
  });
  return roots.flatMap((r) => [r.id, ...r.children.flatMap((c) => [c.id, ...c.children.map((g) => g.id)])]);
}

/**
 * Builds the Prisma where-clause for storefront listing/search from query params.
 * With `scopeOnly`, the shopper-selectable attribute filters are skipped (facet scope).
 */
/** Silver = unplated silver. Gold = 9K/14K/18K or lab-grown, not plated. Demifine = plated. */
function storeWhere(store: string | undefined): Prisma.ProductWhereInput | null {
  if (store === "silver") {
    return {
      AND: [
        { material: { contains: "Silver", mode: "insensitive" } },
        { NOT: { material: { contains: "Plated", mode: "insensitive" } } },
      ],
    };
  }
  if (store === "gold") {
    return {
      AND: [
        { NOT: { material: { contains: "Plated", mode: "insensitive" } } },
        {
          OR: [
            { material: { contains: "14K", mode: "insensitive" } },
            { material: { contains: "18K", mode: "insensitive" } },
            { material: { contains: "9K", mode: "insensitive" } },
            { material: { contains: "22K", mode: "insensitive" } },
            { stone: { contains: "Lab Grown", mode: "insensitive" } },
          ],
        },
      ],
    };
  }
  if (store === "demifine") return { material: { contains: "Plated", mode: "insensitive" } };
  return null;
}

async function listingWhere(req: Request, scopeOnly = false): Promise<Prisma.ProductWhereInput> {
  const and: Prisma.ProductWhereInput[] = [{ status: "ACTIVE" }];
  const store = storeWhere(queryString(req, "store"));
  if (store) and.push(store);
  const q = queryString(req, "q");
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
    for (const t of terms) {
      and.push({
        OR: [
          { name: { contains: t, mode: "insensitive" } },
          { sku: { contains: t, mode: "insensitive" } },
          { material: { contains: t, mode: "insensitive" } },
          { colour: { contains: t, mode: "insensitive" } },
          { stone: { contains: t, mode: "insensitive" } },
          { occasions: { has: t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() } },
          { category: { name: { contains: t, mode: "insensitive" } } },
          { tags: { some: { name: { contains: t, mode: "insensitive" } } } },
        ],
      });
    }
  }
  const categories = queryList(req, "category", /[,|]/);
  if (categories.length) and.push({ categoryId: { in: await categoryScope(categories) } });
  const collection = queryList(req, "collection");
  if (collection.length) and.push({ collections: { some: { slug: { in: collection } } } });
  const tag = queryList(req, "tag");
  if (tag.length) and.push({ tags: { some: { slug: { in: tag } } } });
  const ids = queryList(req, "ids");
  if (ids.length) and.push({ id: { in: ids } });
  if (queryString(req, "bestseller") === "1") and.push({ isBestseller: true });
  if (queryString(req, "newArrival") === "1") and.push({ isNewArrival: true });
  if (queryString(req, "featured") === "1") and.push({ isFeatured: true });
  if (queryString(req, "gift") === "1") and.push({ isGiftable: true });
  if (queryString(req, "flashSale") === "1") and.push({ flashSales: { some: liveFlashSaleWhere() } });
  if (scopeOnly) return { AND: and };

  const material = queryList(req, "material", "|");
  if (material.length) and.push({ material: { in: material } });
  const colour = queryList(req, "colour", "|");
  if (colour.length) and.push({ colour: { in: colour } });
  const stone = queryList(req, "stone", "|");
  if (stone.length) and.push({ stone: { in: stone } });
  const occasion = queryList(req, "occasion", "|");
  if (occasion.length) and.push({ occasions: { hasSome: occasion } });
  const gender = queryList(req, "gender", "|");
  if (gender.length) and.push({ gender: { in: gender } });
  const size = queryList(req, "size", "|");
  if (size.length) and.push({ variants: { some: { size: { in: size }, isActive: true } } });
  const min = Number(queryString(req, "minPrice"));
  const max = Number(queryString(req, "maxPrice"));
  if (Number.isFinite(min) && min > 0) and.push({ price: { gte: min } });
  if (Number.isFinite(max) && max > 0) and.push({ price: { lte: max } });
  const rating = Number(queryString(req, "rating"));
  if (Number.isFinite(rating) && rating > 0) and.push({ ratingAvg: { gte: rating } });
  if (queryString(req, "inStock") === "1") {
    and.push({ variants: { some: { isActive: true, inventory: { some: { quantity: { gt: 0 } } } } } });
  }
  return { AND: and };
}

const SORTS: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  featured: [{ isFeatured: "desc" }, { soldCount: "desc" }, { createdAt: "desc" }],
  popular: [{ soldCount: "desc" }, { ratingCount: "desc" }],
  newest: [{ createdAt: "desc" }],
  price_asc: [{ price: "asc" }],
  price_desc: [{ price: "desc" }],
  rating: [{ ratingAvg: "desc" }, { ratingCount: "desc" }],
  discount: [{ compareAtPrice: { sort: "desc", nulls: "last" } }],
};

/** Facet counts for the filter sidebar (computed on the scope without facet filters). */
async function facets(where: Prisma.ProductWhereInput) {
  const rows = await prisma.product.findMany({
    where,
    select: {
      material: true,
      colour: true,
      stone: true,
      occasions: true,
      gender: true,
      price: true,
      category: { select: { name: true, slug: true } },
      variants: { where: { isActive: true }, select: { size: true } },
    },
  });
  const count = (vals: (string | null | undefined)[]) => {
    const m = new Map<string, number>();
    for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };
  const prices = rows.map((r) => num(r.price));
  const cats = new Map<string, { name: string; slug: string; count: number }>();
  for (const r of rows) {
    if (!r.category) continue;
    const c = cats.get(r.category.slug) ?? { ...r.category, count: 0 };
    c.count++;
    cats.set(r.category.slug, c);
  }
  return {
    categories: [...cats.values()].sort((a, b) => b.count - a.count),
    materials: count(rows.map((r) => r.material)),
    colours: count(rows.map((r) => r.colour)),
    stones: count(rows.map((r) => r.stone)),
    occasions: count(rows.flatMap((r) => r.occasions)),
    genders: count(rows.map((r) => r.gender)),
    sizes: count(rows.flatMap((r) => [...new Set(r.variants.map((v) => v.size))])).sort(
      (a, b) => Number(a.value) - Number(b.value) || a.value.localeCompare(b.value),
    ),
    price: { min: prices.length ? Math.floor(Math.min(...prices)) : 0, max: prices.length ? Math.ceil(Math.max(...prices)) : 0 },
  };
}

router.get("/products", async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const where = await listingWhere(req);
  const sort = SORTS[queryString(req, "sort") ?? "featured"] ?? SORTS.featured;
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy: sort, skip, take, include: productCardInclude() }),
  ]);
  const withFacets = queryString(req, "facets") === "1";
  // Facets ignore the attribute filters so customers can still switch between options.
  res.json({
    items: rows.map(toProductCard),
    meta: pageMeta(total, page, limit),
    facets: withFacets ? await facets(await listingWhere(req, true)) : undefined,
  });
});

router.get("/filters", async (req, res) => {
  const categories = queryList(req, "category");
  res.json(
    await facets({
      status: "ACTIVE",
      ...(categories.length ? { categoryId: { in: await categoryScope(categories) } } : {}),
    }),
  );
});

router.get("/products/:slug", async (req, res) => {
  const slug = param(req, "slug");
  const p = await prisma.product.findFirst({
    where: { OR: [{ slug }, { id: slug }], status: "ACTIVE" },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      category: { include: { parent: { select: { name: true, slug: true } } } },
      collections: { where: { isActive: true }, select: { id: true, name: true, slug: true, type: true } },
      tags: { select: { name: true, slug: true } },
      variants: {
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
        include: { inventory: { where: { warehouse: { isActive: true } } }, images: { select: { id: true, url: true } } },
      },
      flashSales: { where: liveFlashSaleWhere(), take: 1 },
    },
  });
  if (!p) throw notFound("Product not found");
  void prisma.product.update({ where: { id: p.id }, data: { viewCount: { increment: 1 } } }).catch(() => undefined);
  const sale = p.flashSales[0] ?? null;
  const variants = p.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    title: v.title,
    size: v.size,
    colour: v.colour,
    ...priceFor(p, v, sale),
    stock: variantStock(v),
    imageIds: v.images.map((i) => i.id),
  }));
  const stock = variants.reduce((s, v) => s + v.stock, 0);
  res.json(
    serialize({
      id: p.id,
      name: p.name,
      slug: p.slug,
      sku: p.sku,
      shortDescription: p.shortDescription,
      description: p.description,
      ...priceFor(p, p.variants[0], sale),
      images: p.images.map((i) => ({ id: i.id, url: i.url, alt: i.alt ?? p.name, variantId: i.variantId })),
      category: p.category ? { name: p.category.name, slug: p.category.slug, parent: p.category.parent } : null,
      collections: p.collections,
      tags: p.tags,
      material: p.material,
      colour: p.colour,
      stone: p.stone,
      occasions: p.occasions,
      gender: p.gender,
      weight: p.weight,
      dimensions: { length: p.length, width: p.width, height: p.height },
      sizeGuide: p.sizeGuide,
      careInstructions: p.careInstructions,
      warranty: p.warranty,
      hasCertificate: p.hasCertificate,
      isBestseller: p.isBestseller,
      isNewArrival: p.isNewArrival,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      soldCount: p.soldCount,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      variants,
      stock,
      inStock: stock > 0,
      flashSale: sale ? { name: sale.name, endsAt: sale.endsAt } : null,
      reviewSummary: await ratingSummary(p.id),
    }),
  );
});

/** Related (same category) + frequently bought together (co-purchase analysis with fallback). */
router.get("/products/:slug/recommendations", async (req, res) => {
  const slug = param(req, "slug");
  const p = await prisma.product.findFirst({ where: { OR: [{ slug }, { id: slug }] }, select: { id: true, categoryId: true, colour: true, price: true } });
  if (!p) throw notFound("Product not found");

  const related = await prisma.product.findMany({
    where: { status: "ACTIVE", id: { not: p.id }, OR: [{ categoryId: p.categoryId ?? undefined }, { colour: p.colour ?? undefined }] },
    orderBy: [{ soldCount: "desc" }],
    take: 12,
    include: productCardInclude(),
  });

  const coRows = await prisma.$queryRaw<{ productId: string; c: bigint }[]>`
    SELECT oi2."productId", COUNT(*) AS c
    FROM "OrderItem" oi1
    JOIN "OrderItem" oi2 ON oi1."orderId" = oi2."orderId" AND oi2."productId" <> oi1."productId"
    WHERE oi1."productId" = ${p.id} AND oi2."productId" IS NOT NULL
    GROUP BY oi2."productId" ORDER BY c DESC LIMIT 4`;
  let fbtIds = coRows.map((r) => r.productId);
  if (fbtIds.length < 2) {
    // Fallback: complementary items from other categories at a similar price point
    const fallback = await prisma.product.findMany({
      where: { status: "ACTIVE", id: { not: p.id }, categoryId: { not: p.categoryId ?? undefined }, colour: p.colour ?? undefined },
      orderBy: { soldCount: "desc" },
      select: { id: true },
      take: 2,
    });
    fbtIds = [...new Set([...fbtIds, ...fallback.map((f) => f.id)])].slice(0, 2);
  }
  const fbt = await prisma.product.findMany({ where: { id: { in: fbtIds }, status: "ACTIVE" }, include: productCardInclude() });
  res.json(serialize({ related: related.map(toProductCard), frequentlyBoughtTogether: fbt.map(toProductCard) }));
});

router.get("/products/:id/reviews", async (req, res) => {
  const productId = param(req, "id");
  const { page, limit, skip, take } = pageArgs(req.query);
  const rating = Number(queryString(req, "rating"));
  const withPhotos = queryString(req, "photos") === "1";
  const where: Prisma.ReviewWhereInput = {
    productId,
    status: "APPROVED",
    ...(rating ? { rating } : {}),
    ...(withPhotos ? { NOT: { images: { isEmpty: true } } } : {}),
  };
  const sort = queryString(req, "sort");
  const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
    sort === "highest" ? [{ rating: "desc" }] : sort === "lowest" ? [{ rating: "asc" }] : sort === "helpful" ? [{ helpfulCount: "desc" }] : [{ createdAt: "desc" }];
  const [total, items, summary] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy,
      skip,
      take,
      select: { id: true, name: true, rating: true, title: true, body: true, images: true, isVerifiedPurchase: true, adminReply: true, helpfulCount: true, createdAt: true },
    }),
    ratingSummary(productId),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit), summary });
});

router.post("/products/:id/reviews", requireCustomer, async (req, res) => {
  const productId = param(req, "id");
  const body = parse(
    z.object({
      rating: z.number().int().min(1).max(5),
      title: z.string().trim().max(120).optional(),
      body: z.string().trim().min(10, "Please write at least 10 characters").max(2000),
      images: z.array(z.string().url().or(z.string().startsWith("/uploads/"))).max(5).optional(),
    }),
    req.body,
  );
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw notFound("Product not found");
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: req.customer!.sub } });
  const existing = await prisma.review.findFirst({ where: { productId, customerId: customer.id } });
  if (existing) throw badRequest("You have already reviewed this product");
  const purchased = await prisma.orderItem.count({
    where: { productId, order: { customerId: customer.id, status: { in: ["DELIVERED", "SHIPPED", "OUT_FOR_DELIVERY"] } } },
  });
  const review = await prisma.review.create({
    data: {
      productId,
      customerId: customer.id,
      name: customer.name,
      email: customer.email,
      rating: body.rating,
      title: body.title,
      body: body.body,
      images: body.images ?? [],
      isVerifiedPurchase: purchased > 0,
    },
  });
  void prisma.notification
    .create({ data: { type: "REVIEW", title: `New ${body.rating}★ review awaiting approval`, body: body.body.slice(0, 120), link: "/dashboard/reviews" } })
    .catch(() => undefined);
  res.status(201).json({ id: review.id, message: "Thank you! Your review will appear once approved." });
});

router.post("/reviews/:id/helpful", async (req, res) => {
  await prisma.review.update({ where: { id: param(req, "id") }, data: { helpfulCount: { increment: 1 } } });
  res.json({ ok: true });
});

router.get("/categories", async (_req, res) => {
  const rows = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: { where: { status: "ACTIVE" } } } } },
  });
  type Node = (typeof rows)[number] & { children: Node[] };
  const map = new Map<string, Node>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Node[] = [];
  for (const n of map.values()) {
    if (n.parentId && map.has(n.parentId)) map.get(n.parentId)!.children.push(n);
    else roots.push(n);
  }
  res.json(roots);
});

router.get("/categories/:slug", async (req, res) => {
  const c = await prisma.category.findFirst({
    where: { slug: param(req, "slug"), isActive: true },
    include: {
      parent: { select: { name: true, slug: true } },
      children: { where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, slug: true, image: true } },
    },
  });
  if (!c) throw notFound("Category not found");
  res.json(c);
});

router.get("/collections", async (req, res) => {
  const type = queryString(req, "type");
  const rows = await prisma.collection.findMany({
    where: { isActive: true, ...(type ? { type: type as never } : {}), ...(queryString(req, "featured") === "1" ? { isFeatured: true } : {}) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: { where: { status: "ACTIVE" } } } } },
  });
  res.json(rows);
});

router.get("/collections/:slug", async (req, res) => {
  const c = await prisma.collection.findFirst({ where: { slug: param(req, "slug"), isActive: true } });
  if (!c) throw notFound("Collection not found");
  res.json(c);
});

router.get("/search/suggest", async (req, res) => {
  const q = (queryString(req, "q") ?? "").trim();
  if (q.length < 2) {
    const trending = await prisma.product.findMany({
      where: { status: "ACTIVE" },
      orderBy: { soldCount: "desc" },
      take: 4,
      include: productCardInclude(),
    });
    res.json({
      products: trending.map(toProductCard),
      categories: [],
      collections: [],
      popular: ["Silver rings", "Lab grown diamond", "Rose gold earrings", "Anklets", "Mangalsutra", "Gifts for her"],
    });
    return;
  }
  const [products, categories, collections] = await Promise.all([
    prisma.product.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { sku: { contains: q, mode: "insensitive" } },
          { category: { name: { contains: q, mode: "insensitive" } } },
          { stone: { contains: q, mode: "insensitive" } },
          { colour: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { soldCount: "desc" },
      take: 6,
      include: productCardInclude(),
    }),
    prisma.category.findMany({ where: { isActive: true, name: { contains: q, mode: "insensitive" } }, take: 4, select: { name: true, slug: true, image: true } }),
    prisma.collection.findMany({ where: { isActive: true, name: { contains: q, mode: "insensitive" } }, take: 4, select: { name: true, slug: true, image: true } }),
  ]);
  res.json({ products: products.map(toProductCard), categories, collections, popular: [] });
});

/** Everything the homepage needs in one request. */
router.get("/home", async (_req, res) => {
  const now = new Date();
  const activeWindow = { OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] };
  const [banners, categories, bestsellers, newArrivals, collections, flashSale, posts, giftingPicks] = await Promise.all([
    prisma.banner.findMany({ where: { isActive: true, ...activeWindow }, orderBy: { sortOrder: "asc" } }),
    prisma.category.findMany({ where: { isActive: true, parentId: null, showInMenu: true }, orderBy: { sortOrder: "asc" } }),
    prisma.product.findMany({ where: { status: "ACTIVE", isBestseller: true }, orderBy: { soldCount: "desc" }, take: 12, include: productCardInclude() }),
    prisma.product.findMany({ where: { status: "ACTIVE", isNewArrival: true }, orderBy: { createdAt: "desc" }, take: 12, include: productCardInclude() }),
    prisma.collection.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.flashSale.findFirst({
      where: liveFlashSaleWhere(now),
      orderBy: { endsAt: "asc" },
      include: { products: { where: { status: "ACTIVE" }, take: 8, include: productCardInclude() } },
    }),
    prisma.blogPost.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      take: 3,
      select: { title: true, slug: true, excerpt: true, coverImage: true, type: true, publishedAt: true, author: true },
    }),
    prisma.product.findMany({ where: { status: "ACTIVE", isGiftable: true }, orderBy: { ratingAvg: "desc" }, take: 8, include: productCardInclude() }),
  ]);
  res.json(
    serialize({
      banners: {
        hero: banners.filter((b) => b.placement === "HOME_HERO"),
        strip: banners.filter((b) => b.placement === "HOME_STRIP"),
        promo: banners.filter((b) => b.placement === "HOME_PROMO"),
        gifting: banners.filter((b) => b.placement === "GIFTING"),
      },
      categories,
      bestsellers: bestsellers.map(toProductCard),
      newArrivals: newArrivals.map(toProductCard),
      giftingPicks: giftingPicks.map(toProductCard),
      collections: {
        colour: collections.filter((c) => c.type === "COLOUR"),
        bond: collections.filter((c) => c.type === "BOND"),
        occasion: collections.filter((c) => c.type === "OCCASION"),
        celebrity: collections.filter((c) => c.type === "CELEBRITY"),
        gifting: collections.filter((c) => c.type === "GIFTING"),
        curated: collections.filter((c) => c.type === "CURATED"),
      },
      flashSale: flashSale
        ? { name: flashSale.name, description: flashSale.description, endsAt: flashSale.endsAt, bannerImage: flashSale.bannerImage, products: flashSale.products.map(toProductCard) }
        : null,
      posts,
    }),
  );
});

export default router;
