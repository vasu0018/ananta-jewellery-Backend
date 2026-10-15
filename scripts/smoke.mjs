// End-to-end smoke test against a running API: `node scripts/smoke.mjs [baseUrl]`
const BASE = (process.argv[2] || "http://localhost:4000") + "/api/v1";
let failures = 0;

async function call(method, path, { token, body, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  const ok = res.status === expect;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${method} ${path} → ${res.status}${ok ? "" : ` ${typeof data === "string" ? data.slice(0, 160) : JSON.stringify(data).slice(0, 300)}`}`);
  return data;
}

const health = await call("GET", "/health");
const home = await call("GET", "/catalog/home");
console.log(`   home: ${home.bestsellers?.length} bestsellers, ${home.banners?.hero?.length} hero banners, flash sale: ${home.flashSale?.name}`);
const list = await call("GET", "/catalog/products?sort=price_asc&limit=5&facets=1");
console.log(`   listing: ${list.meta?.total} products, facets: ${Object.keys(list.facets ?? {}).join(",")}`);
await call("GET", "/catalog/products?category=earrings&colour=Gold");
const slug = list.items?.[0]?.slug;
const pdp = await call("GET", `/catalog/products/${slug}`);
await call("GET", `/catalog/products/${slug}/recommendations`);
await call("GET", "/catalog/search/suggest?q=ring");
await call("GET", "/catalog/categories");
await call("GET", "/settings/public");
await call("GET", "/content/blog");
await call("GET", "/content/pincode/560001");

// Customer flow
const login = await call("POST", "/auth/login", { body: { email: "priya@example.com", password: "Customer@123" } });
const ct = login.accessToken;
const variantId = pdp.variants?.[0]?.id;
const quote = await call("POST", "/checkout/quote", { token: ct, body: { items: [{ variantId, quantity: 1 }], couponCode: "FLAT200", state: "Karnataka", pincode: "560001" } });
console.log(`   quote: subtotal ${quote.subtotal} discount ${quote.discount} shipping ${quote.shippingFee} total ${quote.total} ${quote.couponError ?? ""}`);
const address = { name: "Priya Sharma", phone: "9876500001", line1: "12, 4th Cross, Indiranagar", city: "Bengaluru", state: "Karnataka", pincode: "560001" };
const cod = await call("POST", "/checkout/orders", { token: ct, expect: 201, body: { items: [{ variantId, quantity: 1 }], paymentMethod: "COD", email: "priya@example.com", phone: "9876500001", shippingAddress: address } });
console.log(`   COD order ${cod.order?.orderNumber} total ${cod.order?.total}`);
const online = await call("POST", "/checkout/orders", { token: ct, expect: 201, body: { items: [{ variantId, quantity: 1 }], paymentMethod: "RAZORPAY", email: "priya@example.com", phone: "9876500001", shippingAddress: address } });
if (online.razorpay) {
  await call("POST", "/checkout/razorpay/verify", {
    token: ct,
    body: { orderNumber: online.order.orderNumber, razorpay_order_id: online.razorpay.orderId, razorpay_payment_id: `pay_mock_${Date.now()}`, razorpay_signature: "mock" },
  });
}
await call("GET", "/account/orders", { token: ct });
await call("GET", "/wishlist", { token: ct });

// Guest checkout
await call("POST", "/checkout/orders", { expect: 201, body: { items: [{ variantId, quantity: 1 }], paymentMethod: "COD", email: `guest${Date.now()}@example.com`, phone: "9123456780", shippingAddress: { ...address, name: "Guest Buyer", phone: "9123456780" } } });

// Admin flow
const admin = await call("POST", "/admin/auth/login", { body: { email: "admin@anantajewellery.in", password: "Admin@123" } });
const at = admin.accessToken;
const dash = await call("GET", "/admin/dashboard?range=30d", { token: at });
console.log(`   dashboard: revenue ${dash.kpis?.revenue?.value} orders ${dash.kpis?.orders?.value} low stock ${dash.lowStock?.count}`);
for (const p of [
  "/admin/counts",
  "/admin/search?q=silver",
  "/admin/products?limit=5",
  "/admin/products?stock=low",
  "/admin/categories",
  "/admin/collections",
  "/admin/tags",
  "/admin/reviews?status=PENDING",
  "/admin/inventory?limit=5",
  "/admin/inventory/low-stock",
  "/admin/inventory/movements?limit=5",
  "/admin/inventory/warehouses",
  "/admin/inventory/transfers",
  "/admin/orders?limit=5",
  "/admin/orders/status-counts",
  "/admin/shipping/shipments",
  "/admin/shipping/queue",
  "/admin/shipping/ndr",
  "/admin/shipping/zones",
  "/admin/shipping/partners",
  "/admin/payments/summary",
  "/admin/payments/transactions?limit=5",
  "/admin/payments/refunds",
  "/admin/payments/settlements",
  "/admin/customers?limit=5",
  "/admin/customers?sort=spent",
  "/admin/customers/tags",
  "/admin/customer-groups",
  "/admin/marketing/coupons",
  "/admin/marketing/flash-sales",
  "/admin/marketing/banners",
  "/admin/marketing/email-templates",
  "/admin/marketing/newsletter",
  "/admin/marketing/abandoned-carts?idle=60",
  "/admin/marketing/posts",
  "/admin/marketing/inquiries",
  "/admin/reports/sales?range=90d&groupBy=week",
  "/admin/reports/products",
  "/admin/reports/categories",
  "/admin/reports/customers",
  "/admin/reports/inventory",
  "/admin/reports/tax?range=1y",
  "/admin/reports/payments",
  "/admin/reports/coupons?range=1y",
  "/admin/settings",
  "/admin/users",
  "/admin/roles",
  "/admin/permissions",
  "/admin/activity-logs",
  "/admin/media",
  "/admin/notifications",
]) {
  await call("GET", p, { token: at });
}

// Order lifecycle on the COD order
const orders = await call("GET", `/admin/orders?q=${cod.order?.orderNumber}`, { token: at });
const orderId = orders.items?.[0]?.id;
const detail = await call("GET", `/admin/orders/${orderId}`, { token: at });
console.log(`   order ${detail.orderNumber}: ${detail.status}, next: ${detail.allowedTransitions?.join(",")}`);
await call("POST", `/admin/orders/${orderId}/shipments`, { token: at, expect: 201, body: {} });
const shipments = await call("GET", `/admin/shipping/shipments?q=${cod.order?.orderNumber}`, { token: at });
const sid = shipments.items?.[0]?.id;
await call("POST", `/admin/shipping/shipments/${sid}/status`, { token: at, body: { status: "IN_TRANSIT", location: "Surat" } });
await call("POST", `/admin/shipping/shipments/${sid}/status`, { token: at, body: { status: "DELIVERED", location: "Bengaluru" } });
const after = await call("GET", `/admin/orders/${orderId}`, { token: at });
console.log(`   after delivery: ${after.status} / ${after.paymentStatus}`);
await call("POST", `/admin/orders/${orderId}/refunds`, { token: at, expect: 201, body: { amount: 100, reason: "Goodwill" } });
const inv = await fetch(`${BASE}/admin/orders/${orderId}/invoice`, { headers: { Authorization: `Bearer ${at}` } });
console.log(`${inv.ok ? "✓" : "✗"} invoice PDF → ${inv.status} ${inv.headers.get("content-type")}`);
if (!inv.ok) failures++;
const csv = await fetch(`${BASE}/admin/orders?format=xlsx`, { headers: { Authorization: `Bearer ${at}` } });
console.log(`${csv.ok ? "✓" : "✗"} orders xlsx export → ${csv.status}`);
const rpdf = await fetch(`${BASE}/admin/reports/sales?format=pdf`, { headers: { Authorization: `Bearer ${at}` } });
console.log(`${rpdf.ok ? "✓" : "✗"} sales report pdf → ${rpdf.status}`);

// Permission check: staff cannot see payments
const staff = await call("POST", "/admin/auth/login", { body: { email: "staff@anantajewellery.in", password: "Staff@123" } });
await call("GET", "/admin/payments/summary", { token: staff.accessToken, expect: 403 });
await call("GET", "/admin/orders", { token: staff.accessToken });

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
