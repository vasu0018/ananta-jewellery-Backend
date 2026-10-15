import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { sendTemplate } from "./mailer";
import { sendCustomerMessages } from "./messaging";
import { getSetting } from "./settings";
import { env } from "../config/env";
import { absoluteUrl } from "./storage";
import { formatInr, num } from "./utils";

const cartInclude = {
  customer: { select: { id: true, name: true, email: true, phone: true, acceptsMarketing: true } },
  items: {
    include: {
      variant: {
        select: {
          id: true,
          sku: true,
          title: true,
          price: true,
          product: { select: { name: true, slug: true, price: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;

function presentCart(c: Prisma.CartGetPayload<{ include: typeof cartInclude }>) {
  const lines = c.items.map((i) => ({
    name: i.variant.product.name,
    variant: i.variant.title,
    sku: i.variant.sku,
    quantity: i.quantity,
    unitPrice: num(i.variant.price ?? i.variant.product.price),
    image: i.variant.product.images[0]?.url ?? null,
    slug: i.variant.product.slug,
  }));
  return {
    id: c.id,
    customer: c.customer,
    updatedAt: c.updatedAt,
    recoveryEmailAt: c.recoveryEmailAt,
    couponCode: c.couponCode,
    items: lines,
    value: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
  };
}

/** Carts idle for at least `idleMinutes` that still hold items. */
export async function abandonedCarts(opts: { idleMinutes?: number; take?: number; skip?: number; onlyUnreminded?: boolean } = {}) {
  const where: Prisma.CartWhereInput = {
    updatedAt: { lt: new Date(Date.now() - (opts.idleMinutes ?? 60) * 60_000) },
    items: { some: {} },
    customer: { isBlocked: false },
    ...(opts.onlyUnreminded ? { recoveryEmailAt: null } : {}),
  };
  const [total, carts] = await Promise.all([
    prisma.cart.count({ where }),
    prisma.cart.findMany({ where, orderBy: { updatedAt: "desc" }, take: opts.take ?? 50, skip: opts.skip ?? 0, include: cartInclude }),
  ]);
  return { total, items: carts.map(presentCart) };
}

export async function sendCartReminder(cartId: string) {
  const row = await prisma.cart.findUnique({ where: { id: cartId }, include: cartInclude });
  if (!row || !row.items.length) return false;
  const cart = presentCart(row);
  const itemsHtml = cart.items
    .map(
      (l) =>
        `<tr><td style="padding:6px 0">${l.image ? `<img src="${absoluteUrl(l.image)}" width="48" height="48" style="border-radius:8px;vertical-align:middle;margin-right:8px"/>` : ""}${l.name} × ${l.quantity}</td><td align="right">${formatInr(l.unitPrice * l.quantity)}</td></tr>`,
    )
    .join("");
  const vars = { customerName: cart.customer.name, itemsHtml, cartTotal: formatInr(cart.value), cartUrl: `${env.STOREFRONT_URL}/cart` };
  const sent = await sendTemplate("ABANDONED_CART", cart.customer.email, vars);
  await sendCustomerMessages("ABANDONED_CART", cart.customer.phone, vars);
  // Keep updatedAt untouched: it measures customer inactivity, not our reminder.
  await prisma.cart.update({ where: { id: cart.id }, data: { recoveryEmailAt: new Date(), updatedAt: row.updatedAt } });
  return !!sent;
}

/** Background job: one reminder per idle cart (after 2 hours) for customers who accept marketing. */
export async function sendAbandonedCartReminders() {
  const notif = await getSetting("notifications");
  if (!notif.email.enabled || !notif.email.events.abandonedCart) return 0;
  const { items } = await abandonedCarts({ idleMinutes: 120, take: 25, onlyUnreminded: true });
  let sent = 0;
  for (const cart of items) {
    if (!cart.customer.acceptsMarketing) continue;
    if (await sendCartReminder(cart.id).catch(() => false)) sent++;
  }
  return sent;
}
