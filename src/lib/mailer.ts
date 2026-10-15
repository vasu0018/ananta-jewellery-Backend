import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { prisma } from "./prisma";
import { getSetting } from "./settings";
import { renderTemplate } from "./utils";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : // No SMTP configured: serialize the message and log it (dev friendly).
      nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

export async function sendMail(to: string, subject: string, html: string) {
  try {
    const info = await getTransporter().sendMail({ from: env.MAIL_FROM, to, subject, html });
    if (!env.SMTP_HOST) console.log(`[mail:dev] → ${to} · ${subject}`);
    return info;
  } catch (e) {
    console.error("[mail] send failed", e);
    return null;
  }
}

/** Wraps template HTML in the branded email layout. */
function layout(inner: string, storeName: string) {
  return `<!doctype html><html><body style="margin:0;background:#f7f3f1;font-family:Helvetica,Arial,sans-serif;color:#1f1f2e">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
  <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden">
  <tr><td style="padding:28px 32px;border-bottom:1px solid #f0e6e2;text-align:center;font-size:22px;letter-spacing:4px;font-weight:600;color:#9b5b6b">${storeName.toUpperCase()}</td></tr>
  <tr><td style="padding:32px;font-size:15px;line-height:1.6">${inner}</td></tr>
  <tr><td style="padding:20px 32px;background:#fbf6f4;font-size:12px;color:#8a8a99;text-align:center">You are receiving this email because of your activity on ${storeName}.</td></tr>
  </table></td></tr></table></body></html>`;
}

/**
 * Send an email using a DB template (EmailTemplate.key). Placeholders use {{var}} syntax.
 * Silently skips if the template is missing or disabled.
 */
export async function sendTemplate(key: string, to: string, vars: Record<string, unknown>) {
  const tpl = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!tpl || !tpl.isActive) return null;
  const { subject, html } = await renderEmail(tpl, vars);
  return sendMail(to, subject, html);
}

/** Render a template (subject + full branded HTML) without sending it. */
export async function renderEmail(tpl: { subject: string; html: string }, vars: Record<string, unknown>) {
  const store = await getSetting("store");
  const allVars = { storeName: store.name, storeUrl: env.STOREFRONT_URL, ...vars };
  return { subject: renderTemplate(tpl.subject, allVars), html: layout(renderTemplate(tpl.html, allVars), store.name) };
}

/** Example values used for previews and test sends from the admin panel. */
export const SAMPLE_EMAIL_VARS: Record<string, string> = {
  customerName: "Priya Sharma",
  orderNumber: "AJ260001",
  orderTotal: "₹3,498.00",
  paymentMethod: "Prepaid",
  orderUrl: `${env.STOREFRONT_URL}/account/orders/AJ260001`,
  trackUrl: `${env.STOREFRONT_URL}/track-order?order=AJ260001`,
  shippingAddress: "12 MG Road, Bengaluru, Karnataka, 560001",
  itemsHtml: '<tr><td style="padding:6px 0">Rose Gold Infinity Ring × 1</td><td align="right">₹1,999.00</td></tr><tr><td style="padding:6px 0">Silver Heart Pendant × 1</td><td align="right">₹1,499.00</td></tr>',
  awb: "AJ1234567890",
  courierName: "Delhivery",
  trackingUrl: "https://www.delhivery.com/track/package/AJ1234567890",
  refundAmount: "₹1,499.00",
  resetUrl: `${env.STOREFRONT_URL}/account/reset-password?token=sample`,
  points: "100",
  cartTotal: "₹3,498.00",
  cartUrl: `${env.STOREFRONT_URL}/cart`,
};
