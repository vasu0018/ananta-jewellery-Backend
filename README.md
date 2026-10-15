# Ananta Jewellery — Backend API

REST API for the Ananta Jewellery storefront and admin panel.
Express 5 · TypeScript · Prisma 6 · PostgreSQL · Zod · JWT (access + rotating refresh tokens) · Razorpay · Nodemailer.

## Quick start

```bash
npm install
cp .env.example .env              # set DATABASE_URL and two random JWT secrets
npx prisma migrate deploy         # or: npm run db:migrate (dev)
npm run db:seed                   # demo catalogue, orders, customers… (wipes all data!)
npm run dev                       # http://localhost:4000/api/v1
npm run smoke                     # end-to-end API check against the running server
```

| Account | Login | Password |
| --- | --- | --- |
| Admin | admin@anantajewellery.in | Admin@123 |
| Manager | manager@anantajewellery.in | Manager@123 |
| Staff | staff@anantajewellery.in | Staff@123 |
| Customer | priya@example.com | Customer@123 |

Production: `npm run build && npm start` (set `NODE_ENV=production`, `COOKIE_SECURE=true`, real JWT secrets and Razorpay keys).

## Project layout

```
prisma/
  schema.prisma          normalised schema (catalog, inventory, orders, payments, shipping, marketing, RBAC)
  seed.ts, seed/         demo data + SVG placeholder artwork written to uploads/seed
src/
  index.ts               boot, invoice sequence, background jobs
  app.ts                 middleware stack & route mounting
  config/env.ts          validated environment
  middleware/            auth (admin/customer/permissions), errors, rate limits
  lib/                   domain logic — pricing, orders, inventory, shipping providers, razorpay, pdf, export, mailer…
  routes/                storefront routes (auth, catalog, store, checkout, content)
  routes/admin/          admin routes (dashboard, catalog, inventory, orders, shipping, payments, customers, marketing, reports, system)
```

## Key design decisions

- **Pricing is server-side only.** `lib/pricing.ts#buildQuote` prices every bag (flash sales, coupons incl. buy-X-get-Y, loyalty points, shipping zone/rate, COD fee, gift wrap, GST back-calculation). Checkout, order placement and admin manual orders all use it.
- **Prices are GST-inclusive** (3% on jewellery, HSN 7113). Invoices split CGST/SGST for intra-state orders and IGST otherwise.
- **Order lifecycle:** `PENDING → CONFIRMED → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED` with `CANCELLED`, `RETURN_REQUESTED`, `RETURNED`. Side effects (stock, loyalty, coupon usage, invoice numbers, emails) live in `lib/orders.ts#changeOrderStatus`.
- **Inventory** is per variant per warehouse. Stock is deducted when an order is placed; unpaid online orders auto-cancel after 30 minutes and are restocked. Every change writes a `StockMovement`.
- **Auth:** separate admin/customer tokens. Access JWT (15 min) + httpOnly refresh cookie (`aj_admin_rt` / `aj_rt`), hashed in DB, rotated on use, whole family revoked on reuse.
- **RBAC:** roles hold permission strings (`orders.write`, `*` …). `x.write` implies `x.read`. Presets: Admin, Manager, Staff.
- **Razorpay mock mode:** with no keys outside production, order ids look like `order_mock_*` and verification succeeds — the full checkout flow works locally.
- **Shipping providers:** Manual, Shiprocket, Delhivery, India Post behind one interface (`lib/shipping`). Configure credentials in Admin → Shipping → Partners. Tracking sync runs every 30 min; couriers can also push to the webhook.
- **Uploads:** images are optimised to WebP with sharp. `STORAGE_DRIVER=local` (default) or `s3` (install `@aws-sdk/client-s3`; works with S3/R2/Spaces).
- **Emails:** DB templates (`{{placeholders}}`) editable in the admin. Without `SMTP_HOST` emails are logged to the console.

## Background jobs (in-process)

| Job | Interval |
| --- | --- |
| Cancel unpaid online orders | 5 min |
| Sync courier tracking | 30 min |
| Abandoned cart reminders | 30 min |

Disable with `DISABLE_JOBS=1` (e.g. when running several API instances — run one worker with jobs on).

## Webhooks

- Razorpay: `POST /api/v1/webhooks/razorpay` (set the secret in Admin → Settings → Payments)
- Couriers: `POST /api/v1/webhooks/shipping/{SHIPROCKET|DELHIVERY}?token=<webhook token from partner settings>`

## API overview (`/api/v1`)

**Storefront**
- `auth/*` register, login (email or phone), refresh, logout, me, forgot/reset password
- `catalog/home`, `catalog/products` (filters: q, category, collection, material, colour, stone, occasion, gender, size, price, rating, flags; sorts; `facets=1`), `catalog/products/:slug`, `…/recommendations`, `…/reviews`, `catalog/categories`, `catalog/collections`, `catalog/search/suggest`
- `cart`, `cart/quote`, `cart/merge`, `wishlist`, `account/profile|password|loyalty|addresses|orders` (cancel, return, invoice PDF)
- `checkout/quote`, `checkout/offers`, `checkout/orders`, `checkout/razorpay/verify|failed`, `checkout/track`
- `settings/public`, `content/banners`, `content/blog`, `content/newsletter`, `content/contact`, `content/track`, `content/pincode/:pincode`

**Admin** (`/admin`, bearer token + permissions)
- `auth/*`, `dashboard`, `search`, `notifications`, `counts`
- `products` (+ `bulk`, `import`, `export`, `import-template`, `:id/duplicate`), `categories` (+ `reorder`), `collections` (+ `:id/products`), `tags`, `reviews` (+ `bulk`)
- `inventory` (+ `adjust`, `bulk`, `import`, `movements`, `low-stock`, `warehouses`, `transfers` dispatch/receive/cancel)
- `orders` (filters, `format=csv|xlsx|pdf`, `status-counts`, `bulk-status`, manual create/quote, `:id/status`, `notes`, `mark-paid`, `refunds`, `invoice`, `packing-slip`)
- `shipping/shipments` (create, bulk-create, label, sync, status, pickup, cancel), `shipping/queue`, `shipping/ndr`, `shipping/zones` + rates, `shipping/partners` (+ test)
- `payments/summary|transactions|refunds|settlements` (+ sync)
- `customers` (+ detail with LTV, loyalty adjust, bulk, tags), `customer-groups`
- `marketing/coupons|flash-sales|banners|email-templates|newsletter|abandoned-carts|posts|inquiries`
- `reports/sales|products|categories|customers|inventory|tax|payments|coupons` (`format=csv|xlsx|pdf`)
- `settings/:key`, `users`, `roles`, `permissions`, `activity-logs`, `media`
