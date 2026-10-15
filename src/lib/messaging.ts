import { getSetting } from "./settings";

/**
 * SMS (MSG91 Flow API) and WhatsApp (Meta Cloud API) notifications.
 *
 * Both channels use pre-approved templates, so the admin maps each event
 * to a provider template id / name in Settings → Notifications. Events without
 * a mapped template are skipped silently.
 */

/** Events that can trigger an SMS / WhatsApp, keyed like the email templates. */
export const MESSAGE_EVENTS = {
  ORDER_CONFIRMATION: { label: "Order confirmed", params: ["customerName", "orderNumber", "orderTotal"] },
  ORDER_SHIPPED: { label: "Order shipped", params: ["customerName", "orderNumber", "courierName", "awb", "trackingUrl"] },
  ORDER_DELIVERED: { label: "Order delivered", params: ["customerName", "orderNumber"] },
  ORDER_CANCELLED: { label: "Order cancelled", params: ["customerName", "orderNumber"] },
  REFUND_PROCESSED: { label: "Refund processed", params: ["customerName", "refundAmount", "orderNumber"] },
  ABANDONED_CART: { label: "Abandoned cart", params: ["customerName", "cartTotal", "cartUrl"] },
} as const;

export type MessageEvent = keyof typeof MESSAGE_EVENTS;
type Vars = Record<string, unknown>;

/** "+91 98765-43210" / "9876543210" → "919876543210" */
export function toMsisdn(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text;
}

export async function sendSms(event: MessageEvent, phone: string, vars: Vars, opts: { templateId?: string } = {}) {
  const { sms } = await getSetting("notifications");
  const templateId = opts.templateId ?? sms.templateIds[event];
  if (!opts.templateId && (!sms.enabled || !templateId)) return false;
  if (!templateId) throw new Error("No MSG91 template id for this event");
  if (!sms.apiKey) {
    console.log(`[sms:dev] → ${toMsisdn(phone)} · ${event} (no MSG91 auth key configured)`);
    return false;
  }
  // MSG91 flow variables are named var1, var2… in the same order as MESSAGE_EVENTS params.
  const recipient: Record<string, string> = { mobiles: toMsisdn(phone) };
  MESSAGE_EVENTS[event].params.forEach((p, i) => (recipient[`var${i + 1}`] = String(vars[p] ?? "")));
  await postJson("https://control.msg91.com/api/v5/flow/", { authkey: sms.apiKey }, { template_id: templateId, short_url: "0", recipients: [recipient] });
  return true;
}

export async function sendWhatsapp(event: MessageEvent, phone: string, vars: Vars, opts: { templateName?: string } = {}) {
  const { whatsapp } = await getSetting("notifications");
  const templateName = opts.templateName ?? whatsapp.templates[event];
  if (!opts.templateName && (!whatsapp.enabled || !templateName)) return false;
  if (!templateName) throw new Error("No WhatsApp template name for this event");
  if (!whatsapp.accessToken || !whatsapp.phoneNumberId) {
    console.log(`[whatsapp:dev] → ${toMsisdn(phone)} · ${event} (Meta Cloud API not configured)`);
    return false;
  }
  // Template body placeholders {{1}}, {{2}}… follow the MESSAGE_EVENTS param order.
  const parameters = MESSAGE_EVENTS[event].params.map((p) => ({ type: "text", text: String(vars[p] ?? "-") }));
  await postJson(
    `https://graph.facebook.com/v20.0/${whatsapp.phoneNumberId}/messages`,
    { Authorization: `Bearer ${whatsapp.accessToken}` },
    {
      messaging_product: "whatsapp",
      to: toMsisdn(phone),
      type: "template",
      template: { name: templateName, language: { code: "en" }, components: [{ type: "body", parameters }] },
    },
  );
  return true;
}

/** Fire SMS + WhatsApp for an event; failures are logged, never thrown. */
export async function sendCustomerMessages(event: MessageEvent, phone: string | null | undefined, vars: Vars) {
  if (!phone) return;
  await Promise.all([
    sendSms(event, phone, vars).catch((e) => console.error(`[sms] ${event} failed`, e instanceof Error ? e.message : e)),
    sendWhatsapp(event, phone, vars).catch((e) => console.error(`[whatsapp] ${event} failed`, e instanceof Error ? e.message : e)),
  ]);
}
