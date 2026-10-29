import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { notFound, pageArgs, pageMeta, param, parse, queryString } from "../lib/http";
import { getRazorpayConfig, getSetting } from "../lib/settings";
import { authLimiter } from "../middleware/rateLimit";
import { buildQuote } from "../lib/pricing";
import { addDays } from "../lib/utils";

const router = Router();

/** Public store configuration for the storefront & admin login screen. */
router.get("/settings/public", async (_req, res) => {
  const [store, checkout, loyalty, payments, seo, rzp] = await Promise.all([
    getSetting("store"),
    getSetting("checkout"),
    getSetting("loyalty"),
    getSetting("payments"),
    getSetting("seo"),
    getRazorpayConfig(),
  ]);
  res.json({
    store,
    seo,
    checkout: {
      freeShippingAbove: checkout.freeShippingAbove,
      codEnabled: checkout.codEnabled && payments.methods.cod,
      codFee: checkout.codFee,
      giftWrapFee: checkout.giftWrapFee,
      guestCheckout: checkout.guestCheckout,
    },
    loyalty: { enabled: loyalty.enabled, pointValue: loyalty.pointValue, earnPer100: loyalty.earnPer100, signupBonus: loyalty.signupBonus },
    payments: {
      razorpayEnabled: payments.razorpay.enabled,
      razorpayKeyId: rzp.mock ? null : rzp.keyId,
      mock: rzp.mock,
      methods: payments.methods,
    },
  });
});

router.get("/content/banners", async (req, res) => {
  const placement = queryString(req, "placement");
  const now = new Date();
  res.json(
    await prisma.banner.findMany({
      where: {
        isActive: true,
        ...(placement ? { placement: placement as never } : {}),
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      orderBy: { sortOrder: "asc" },
    }),
  );
});

router.get("/content/blog", async (req, res) => {
  const { page, limit, skip, take } = pageArgs(req.query);
  const type = queryString(req, "type");
  const tag = queryString(req, "tag");
  const where = {
    status: "PUBLISHED" as const,
    ...(type ? { type: type as never } : {}),
    ...(tag ? { tags: { has: tag } } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.blogPost.count({ where }),
    prisma.blogPost.findMany({
      where,
      orderBy: { publishedAt: "desc" },
      skip,
      take,
      select: { id: true, title: true, slug: true, excerpt: true, coverImage: true, type: true, author: true, tags: true, publishedAt: true },
    }),
  ]);
  res.json({ items, meta: pageMeta(total, page, limit) });
});

router.get("/content/blog/:slug", async (req, res) => {
  const post = await prisma.blogPost.findFirst({ where: { slug: param(req, "slug"), status: "PUBLISHED" } });
  if (!post) throw notFound("Post not found");
  const more = await prisma.blogPost.findMany({
    where: { status: "PUBLISHED", id: { not: post.id } },
    orderBy: { publishedAt: "desc" },
    take: 3,
    select: { title: true, slug: true, coverImage: true, excerpt: true, publishedAt: true },
  });
  res.json({ ...post, more });
});

router.post("/content/newsletter", authLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().max(80).optional(), source: z.string().max(40).optional() }), req.body);
  await prisma.newsletterSubscriber.upsert({
    where: { email: body.email },
    create: { email: body.email, name: body.name, source: body.source ?? "footer" },
    update: { status: "SUBSCRIBED" },
  });
  res.status(201).json({ ok: true, message: "You're on the list! Look out for exclusive offers." });
});

router.post("/content/contact", authLimiter, async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80),
      email: z.string().trim().email(),
      phone: z.string().trim().max(24).optional(),
      subject: z.string().max(120).optional(),
      message: z.string().trim().min(10).max(3000),
    }),
    req.body,
  );
  await prisma.inquiry.create({ data: body });
  await prisma.notification.create({ data: { type: "INQUIRY", title: `New enquiry from ${body.name}`, body: body.subject ?? body.message.slice(0, 100), link: "/dashboard/marketing/inquiries" } });
  res.status(201).json({ ok: true, message: "Thanks for reaching out — we'll reply within 24 hours." });
});

/** Anonymous daily counters: visit (once per session), product_view, add_to_cart, checkout. */
router.post("/content/track", async (req, res) => {
  const { event } = parse(z.object({ event: z.enum(["visit", "product_view", "add_to_cart", "checkout"]) }), req.body);
  const field = { visit: "visits", product_view: "productViews", add_to_cart: "addToCarts", checkout: "checkouts" }[event] as
    | "visits"
    | "productViews"
    | "addToCarts"
    | "checkouts";
  const d = new Date();
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  await prisma.dailyTraffic.upsert({ where: { date }, create: { date, [field]: 1 }, update: { [field]: { increment: 1 } } });
  res.status(204).end();
});

const STATE_ALIASES: Record<string, string> = {
  orissa: "Odisha",
  pondicherry: "Puducherry",
  "nct of delhi": "Delhi",
  "jammu & kashmir": "Jammu and Kashmir",
  "jammu and kashmir": "Jammu and Kashmir",
  "andaman & nicobar islands": "Andaman and Nicobar Islands",
  "dadra and nagar haveli": "Dadra and Nagar Haveli and Daman and Diu",
  "dadra & nagar haveli": "Dadra and Nagar Haveli and Daman and Diu",
  "daman and diu": "Dadra and Nagar Haveli and Daman and Diu",
  "daman & diu": "Dadra and Nagar Haveli and Daman and Diu",
};

const CANONICAL_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

function matchState(raw: string) {
  const key = raw.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
  return STATE_ALIASES[key] ?? CANONICAL_STATES.find((s) => s.toLowerCase() === key) ?? raw;
}

type Places = { city: string; state: string; localities: string[] };
const placeCache = new Map<string, { at: number; places: Places | null }>();

/** India Post directory: city, state and post-office areas for a 6-digit pincode. */
async function lookupPlaces(pincode: string): Promise<Places | null> {
  const hit = placeCache.get(pincode);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.places;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let places: Places | null = null;
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, { signal: ctrl.signal });
    const body = (await res.json()) as { Status?: string; PostOffice?: { Name?: string; District?: string; State?: string }[] | null }[];
    const offices = body?.[0]?.Status === "Success" ? body[0].PostOffice ?? [] : [];
    if (offices.length) {
      const localities = [...new Set(offices.map((o) => o.Name?.trim()).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));
      places = {
        city: offices[0].District?.trim() || localities[0] || "",
        state: matchState(offices[0].State?.trim() || ""),
        localities,
      };
    }
  } catch {
    places = null;
  } finally {
    clearTimeout(timer);
  }
  placeCache.set(pincode, { at: Date.now(), places });
  return places;
}

/** Pincode serviceability + delivery estimate for the product page. */
router.get("/content/pincode/:pincode", async (req, res) => {
  const pincode = param(req, "pincode");
  if (!/^\d{6}$/.test(pincode)) {
    res.status(400).json({ message: "Enter a valid 6-digit pincode" });
    return;
  }
  const variantId = queryString(req, "variantId");
  const quote = variantId ? await buildQuote({ items: [{ variantId, quantity: 1 }], pincode }) : null;
  const zones = await prisma.shippingZone.findMany({ where: { isActive: true }, include: { rates: { where: { isActive: true }, orderBy: { price: "asc" } } } });
  const zone =
    zones.find((z) => z.pincodes.some((p) => pincode.startsWith(p))) ?? zones.find((z) => z.states.length === 0 && z.pincodes.length === 0);
  const rate = quote?.shippingOptions[0] ?? (zone?.rates[0] ? { minDays: zone.rates[0].minDays, maxDays: zone.rates[0].maxDays, codAvailable: zone.rates[0].codAvailable, price: Number(zone.rates[0].price) } : null);
  if (!rate) {
    res.json({ serviceable: false, message: "Sorry, we don't deliver to this pincode yet.", places: await lookupPlaces(pincode) });
    return;
  }
  const shipping = await getSetting("shipping");
  const eta = addDays(new Date(), rate.maxDays + shipping.processingDays);
  const places = await lookupPlaces(pincode);
  res.json({
    serviceable: true,
    codAvailable: rate.codAvailable,
    minDays: rate.minDays,
    maxDays: rate.maxDays,
    estimatedDelivery: eta,
    shippingFee: rate.price,
    message: `Delivery by ${eta.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`,
    places,
  });
});

export default router;
