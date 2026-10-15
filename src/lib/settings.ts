import { prisma } from "./prisma";
import { env } from "../config/env";

/**
 * Typed settings stored as JSON rows in the `Setting` table.
 * Every key has defaults so the app works on an empty database.
 */
export const SETTING_DEFAULTS = {
  store: {
    name: "Ananta Jewellery",
    tagline: "Fine silver & lab-grown diamond jewellery",
    logoUrl: null as string | null,
    faviconUrl: null as string | null,
    email: "care@anantajewellery.in",
    phone: "+91 98765 43210",
    whatsapp: "+91 98765 43210",
    address: "2nd Floor, Ananta House, MG Road",
    city: "Surat",
    state: "Gujarat",
    pincode: "395007",
    country: "India",
    currency: "INR",
    timezone: "Asia/Kolkata",
    social: {
      instagram: "https://instagram.com/",
      facebook: "https://facebook.com/",
      youtube: "https://youtube.com/",
      pinterest: "https://pinterest.com/",
    },
    announcement: "Free shipping on orders above ₹999 · Lifetime plating service",
  },
  tax: {
    gstin: "24ABCDE1234F1Z5",
    legalName: "Ananta Jewellery Pvt. Ltd.",
    /** Default GST on jewellery in India */
    defaultRate: 3,
    pricesIncludeTax: true,
    invoicePrefix: "AJ/INV",
    hsnCode: "7113",
  },
  checkout: {
    freeShippingAbove: 999,
    codEnabled: true,
    codFee: 49,
    codMaxOrderValue: 25000,
    giftWrapFee: 49,
    guestCheckout: true,
    minOrderValue: 0,
    autoCancelUnpaidMinutes: 30,
  },
  loyalty: {
    enabled: true,
    /** points earned per ₹100 spent */
    earnPer100: 1,
    /** ₹ value of one point */
    pointValue: 1,
    maxRedeemPercent: 20,
    signupBonus: 100,
  },
  payments: {
    razorpay: {
      enabled: true,
      mode: "test" as "test" | "live",
      keyId: "",
      keySecret: "",
      webhookSecret: "",
    },
    methods: { upi: true, card: true, netbanking: true, wallet: true, cod: true },
  },
  notifications: {
    email: {
      enabled: true,
      adminRecipients: ["orders@anantajewellery.in"],
      events: {
        orderPlaced: true,
        orderShipped: true,
        orderDelivered: true,
        orderCancelled: true,
        refundProcessed: true,
        abandonedCart: true,
        lowStockAdmin: true,
      },
    },
    sms: { enabled: false, provider: "msg91", apiKey: "", senderId: "ANANTA", templateIds: {} as Record<string, string> },
    whatsapp: { enabled: false, provider: "meta", phoneNumberId: "", accessToken: "", templates: {} as Record<string, string> },
  },
  shipping: {
    defaultPartner: "MANUAL",
    defaultWeightGrams: 50,
    packageLength: 12,
    packageWidth: 10,
    packageHeight: 5,
    processingDays: 1,
  },
  seo: {
    defaultTitle: "Ananta Jewellery — Silver & Lab-Grown Diamond Jewellery",
    defaultDescription:
      "Shop certified 925 silver, gold-plated and lab-grown diamond jewellery. Free shipping, easy 30-day returns, lifetime plating & COD available.",
    ogImage: null as string | null,
  },
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(out[k]) && isObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const cache = new Map<string, { value: unknown; at: number }>();
const TTL = 30_000;

export async function getSetting<K extends SettingKey>(key: K): Promise<Settings<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as Settings<K>;
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = deepMerge(SETTING_DEFAULTS[key], row?.value ?? {});
  cache.set(key, { value, at: Date.now() });
  return value as Settings<K>;
}

export async function setSetting<K extends SettingKey>(key: K, patch: unknown) {
  const current = await getSetting(key);
  const value = deepMerge(current, patch);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
  cache.delete(key);
  return value as Settings<K>;
}

/** Razorpay credentials: admin settings first, then environment variables. */
export async function getRazorpayConfig() {
  const p = await getSetting("payments");
  const keyId = p.razorpay.keyId || env.RAZORPAY_KEY_ID || "";
  const keySecret = p.razorpay.keySecret || env.RAZORPAY_KEY_SECRET || "";
  const webhookSecret = p.razorpay.webhookSecret || env.RAZORPAY_WEBHOOK_SECRET || "";
  return {
    enabled: p.razorpay.enabled,
    mode: p.razorpay.mode,
    keyId,
    keySecret,
    webhookSecret,
    /** Mock mode lets the full checkout flow run locally without real keys. */
    mock: !keyId || !keySecret,
  };
}

/** Mask secrets before sending settings to the admin UI. */
export function maskSecret(s?: string | null) {
  if (!s) return "";
  return s.length <= 6 ? "••••" : `${s.slice(0, 4)}••••${s.slice(-2)}`;
}
