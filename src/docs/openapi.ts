/**
 * OpenAPI 3 spec for the Ananta Jewellery REST API.
 * Mobile apps should implement the Customer tag group. Admin routes are the store console.
 */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Ananta Jewellery API",
    version: "1.0.0",
    description: `
REST API for the Ananta Jewellery store app, website, and admin console.

**Base path:** \`/api/v1\`

### Mobile app (customer)
1. Call **POST /api/v1/auth/login** or **POST /api/v1/auth/register**.
2. Store \`accessToken\` (about 15 minutes) and \`refreshToken\` (30 days) on the device.
3. Send \`Authorization: Bearer <accessToken>\` on protected calls.
4. When a call returns **401**, call **POST /api/v1/auth/refresh** with \`{ "refreshToken": "..." }\` and replace both tokens. Each refresh token works once.
5. **POST /api/v1/auth/logout** with the current \`refreshToken\` in the body.

The website also receives the refresh token as an httpOnly cookie. Native apps must use the JSON \`refreshToken\` field.

Prices are in **INR** and are **GST-inclusive**. Image fields are absolute URLs, for example \`http://host:4000/uploads/seed/banner-hero-2.webp\`.

### Try-it-out accounts (seed data)
- Customer: \`priya@example.com\` / \`Customer@123\`
- Admin: \`admin@anantajewellery.in\` / \`Admin@123\`

### Errors
\`{ "message": "Human readable reason", "details": [{ "path": "field", "message": "..." }] }\`
    `.trim(),
  },
  servers: [{ url: "/", description: "The host this page was opened on" }],
  tags: [
    { name: "Health", description: "Liveness" },
    { name: "Auth", description: "Customer registration, login, and session. Use these in the mobile app." },
    { name: "Catalog", description: "Public product, category, collection, search, and home data." },
    { name: "Cart", description: "Signed-in bag. Guests should keep the bag on device and merge after login." },
    { name: "Wishlist", description: "Signed-in wishlist." },
    { name: "Account", description: "Profile, addresses, loyalty, and the customer's orders." },
    { name: "Checkout", description: "Quote, place order, Razorpay, and guest tracking." },
    { name: "Content", description: "Store settings, banners, blog, contact, pincode, analytics ping." },
    { name: "Admin", description: "Admin console only. Not used by the customer mobile app. Requires an admin access token." },
  ],
  components: {
    securitySchemes: {
      customerBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Customer access token from /api/v1/auth/login or /register or /refresh.",
      },
      adminBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Admin access token from /api/v1/admin/auth/login.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          message: { type: "string" },
          details: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["message"],
      },
      PageMeta: {
        type: "object",
        properties: {
          total: { type: "integer" },
          page: { type: "integer" },
          limit: { type: "integer" },
          pages: { type: "integer" },
        },
      },
      Customer: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string", nullable: true, example: "9876500001" },
          avatarUrl: { type: "string", nullable: true },
          loyaltyPoints: { type: "integer" },
          dateOfBirth: { type: "string", format: "date-time", nullable: true },
          anniversary: { type: "string", format: "date-time", nullable: true },
          gender: { type: "string", nullable: true },
          acceptsMarketing: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      AuthSession: {
        type: "object",
        properties: {
          accessToken: { type: "string", description: "JWT. Send as Authorization: Bearer." },
          refreshToken: { type: "string", description: "Opaque token. Send in the body of /auth/refresh. Single use." },
          customer: { $ref: "#/components/schemas/Customer" },
        },
        required: ["accessToken", "refreshToken", "customer"],
      },
      CartItem: {
        type: "object",
        required: ["variantId", "quantity"],
        properties: {
          variantId: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
      Address: {
        type: "object",
        required: ["name", "phone", "line1", "city", "state", "pincode"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          phone: { type: "string", description: "Indian mobile, 10 digits." },
          line1: { type: "string" },
          line2: { type: "string", nullable: true },
          landmark: { type: "string", nullable: true },
          city: { type: "string" },
          state: { type: "string" },
          pincode: { type: "string", pattern: "^\\d{6}$" },
          country: { type: "string", default: "India" },
          type: { type: "string", enum: ["HOME", "WORK", "OTHER"] },
          isDefault: { type: "boolean" },
        },
      },
      ProductCard: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
          sku: { type: "string" },
          price: { type: "number", description: "Selling price in INR, GST inclusive." },
          compareAtPrice: { type: "number", nullable: true },
          discountPct: { type: "integer" },
          image: { type: "string", nullable: true },
          hoverImage: { type: "string", nullable: true },
          category: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } },
          material: { type: "string", nullable: true },
          colour: { type: "string", nullable: true },
          stone: { type: "string", nullable: true },
          occasions: { type: "array", items: { type: "string" } },
          ratingAvg: { type: "number" },
          ratingCount: { type: "integer" },
          isBestseller: { type: "boolean" },
          isNewArrival: { type: "boolean" },
          inStock: { type: "boolean" },
          stock: { type: "integer" },
          defaultVariantId: { type: "string", nullable: true, description: "Use this variantId when adding to cart if the shopper has not picked a size." },
          variants: { type: "array", items: { $ref: "#/components/schemas/VariantPrice" } },
          flashSale: { type: "object", nullable: true, properties: { name: { type: "string" }, endsAt: { type: "string", format: "date-time" } } },
        },
      },
      VariantPrice: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          size: { type: "string", nullable: true },
          colour: { type: "string", nullable: true },
          price: { type: "number" },
          compareAtPrice: { type: "number", nullable: true },
          discountPct: { type: "integer" },
          stock: { type: "integer" },
        },
      },
      QuoteRequest: {
        type: "object",
        required: ["items"],
        properties: {
          items: { type: "array", maxItems: 50, items: { $ref: "#/components/schemas/CartItem" } },
          couponCode: { type: "string", nullable: true },
          state: { type: "string", nullable: true, description: "Delivery state. Needed to split CGST/SGST vs IGST." },
          pincode: { type: "string", nullable: true },
          paymentMethod: { type: "string", enum: ["RAZORPAY", "COD"], nullable: true },
          shippingRateId: { type: "string", nullable: true },
          giftWrap: { type: "boolean" },
          loyaltyPoints: { type: "integer", minimum: 0, description: "Ignored unless the customer bearer token is sent." },
          email: { type: "string", format: "email", nullable: true },
        },
      },
    },
    responses: {
      Error: { description: "Request failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      Unauthorized: { description: "Missing or expired access token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  },
  paths: {
    "/api/v1/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        responses: { "200": { description: "{ ok: true, time }" } },
      },
    },
    "/api/v1/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Create a customer account",
        requestBody: jsonBody({
          type: "object",
          required: ["name", "email", "password"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 80 },
            email: { type: "string", format: "email" },
            phone: { type: "string", description: "Optional Indian mobile." },
            password: { type: "string", minLength: 8, maxLength: 100 },
            acceptsMarketing: { type: "boolean" },
          },
        }),
        responses: {
          "201": { description: "Account created", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } } },
          "202": { description: "Email already used as a guest. A set-password link was emailed. Body: { verify: true, message }." },
          "400": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Sign in with email or phone",
        requestBody: jsonBody({
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", description: "Email address or phone number." },
            password: { type: "string" },
          },
        }, { email: "priya@example.com", password: "Customer@123" }),
        responses: {
          "200": { description: "Signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Rotate the refresh token and get a new access token",
        description: "Send the refresh token in the JSON body. The previous refresh token is revoked. Store the new refreshToken from the response.",
        requestBody: jsonBody({
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string" } },
        }),
        responses: {
          "200": { description: "New session", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Revoke the refresh token",
        requestBody: jsonBody({ type: "object", properties: { refreshToken: { type: "string" } } }),
        responses: { "200": { description: "{ ok: true }" } },
      },
    },
    "/api/v1/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Current customer",
        security: [{ customerBearer: [] }],
        responses: {
          "200": { description: "Customer profile", content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/auth/forgot-password": {
      post: {
        tags: ["Auth"],
        summary: "Email a password reset link",
        description: "Always returns 200 so email addresses cannot be enumerated.",
        requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }),
        responses: { "200": { description: "{ ok: true, message }" } },
      },
    },
    "/api/v1/auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Set a new password with the emailed token",
        requestBody: jsonBody({
          type: "object",
          required: ["token", "password"],
          properties: { token: { type: "string" }, password: { type: "string", minLength: 8 } },
        }),
        responses: { "200": { description: "{ ok: true }" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/catalog/home": {
      get: {
        tags: ["Catalog"],
        summary: "Homepage payload",
        description: "Banners (hero, strip, promo, gifting), menu categories, bestsellers, new arrivals, gifting picks, collections grouped by type, live flash sale, and latest posts.",
        responses: { "200": { description: "Home screen data. Product lists use the product card shape." } },
      },
    },
    "/api/v1/catalog/products": {
      get: {
        tags: ["Catalog"],
        summary: "List and search products",
        parameters: [
          q("page", "Page number. Default 1."),
          q("limit", "Page size, 1–200. Default 20."),
          q("q", "Search text. Split into up to 6 words."),
          q("sort", "featured | popular | newest | price_asc | price_desc | rating | discount"),
          q("store", "silver | gold | demifine"),
          q("category", "Category slug. Comma-separated. Includes child categories."),
          q("collection", "Collection slug, comma-separated."),
          q("tag", "Tag slug, comma-separated."),
          q("ids", "Product ids, comma-separated."),
          q("material", "Exact material. Use | between values."),
          q("colour", "Exact colour. Use | between values."),
          q("stone", "Exact stone. Use | between values."),
          q("occasion", "Occasion. Use | between values."),
          q("gender", "Gender. Use | between values."),
          q("size", "Variant size. Use | between values."),
          q("minPrice", "Minimum selling price."),
          q("maxPrice", "Maximum selling price."),
          q("rating", "Minimum average rating."),
          q("bestseller", "1 to only bestsellers."),
          q("newArrival", "1 to only new arrivals."),
          q("featured", "1 to only featured."),
          q("gift", "1 to only giftable products."),
          q("flashSale", "1 to only products in a live flash sale."),
          q("inStock", "1 to hide out-of-stock products."),
          q("facets", "1 to also return filter counts (categories, materials, colours, stones, occasions, genders, sizes, price min/max)."),
        ],
        responses: {
          "200": {
            description: "{ items: ProductCard[], meta: PageMeta, facets? }",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/ProductCard" } },
                    meta: { $ref: "#/components/schemas/PageMeta" },
                    facets: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/catalog/filters": {
      get: {
        tags: ["Catalog"],
        summary: "Filter facets for the shop",
        parameters: [q("category", "Optional category slug, comma-separated.")],
        responses: { "200": { description: "Same facet object as products?facets=1." } },
      },
    },
    "/api/v1/catalog/products/{slug}": {
      get: {
        tags: ["Catalog"],
        summary: "Product detail",
        description: "Lookup by slug or product id. Includes images, variants (with stock and price), size guide, care, rating summary, and flash sale.",
        parameters: [pathParam("slug", "Product slug or id")],
        responses: { "200": { description: "Product detail" }, "404": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/catalog/products/{slug}/recommendations": {
      get: {
        tags: ["Catalog"],
        summary: "Related products and frequently bought together",
        parameters: [pathParam("slug", "Product slug or id")],
        responses: { "200": { description: "{ related: ProductCard[], frequentlyBoughtTogether: ProductCard[] }" } },
      },
    },
    "/api/v1/catalog/products/{id}/reviews": {
      get: {
        tags: ["Catalog"],
        summary: "Approved reviews",
        parameters: [
          pathParam("id", "Product id"),
          q("page", "Page"),
          q("limit", "Page size"),
          q("rating", "Exact star rating 1–5"),
          q("photos", "1 to only reviews with photos"),
          q("sort", "newest (default) | highest | lowest | helpful"),
        ],
        responses: { "200": { description: "{ items, meta, summary }" } },
      },
      post: {
        tags: ["Catalog"],
        summary: "Write a review",
        description: "One review per customer per product. Shown after admin approval. Upload photos first with POST /api/v1/uploads/review.",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("id", "Product id")],
        requestBody: jsonBody({
          type: "object",
          required: ["rating", "body"],
          properties: {
            rating: { type: "integer", minimum: 1, maximum: 5 },
            title: { type: "string", maxLength: 120 },
            body: { type: "string", minLength: 10, maxLength: 2000 },
            images: { type: "array", maxItems: 5, items: { type: "string" } },
          },
        }),
        responses: { "201": { description: "{ id, message }" }, "400": { $ref: "#/components/responses/Error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/api/v1/catalog/reviews/{id}/helpful": {
      post: {
        tags: ["Catalog"],
        summary: "Mark a review helpful",
        parameters: [pathParam("id", "Review id")],
        responses: { "200": { description: "{ ok: true }" } },
      },
    },
    "/api/v1/catalog/categories": {
      get: { tags: ["Catalog"], summary: "Category tree", responses: { "200": { description: "Active categories nested by parent, each with product count." } } },
    },
    "/api/v1/catalog/categories/{slug}": {
      get: {
        tags: ["Catalog"],
        summary: "One category",
        parameters: [pathParam("slug", "Category slug")],
        responses: { "200": { description: "Category with parent and children" }, "404": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/catalog/collections": {
      get: {
        tags: ["Catalog"],
        summary: "Collections",
        parameters: [q("type", "COLOUR | BOND | OCCASION | CELEBRITY | GIFTING | CURATED"), q("featured", "1 for featured only")],
        responses: { "200": { description: "Active collections with product counts." } },
      },
    },
    "/api/v1/catalog/collections/{slug}": {
      get: {
        tags: ["Catalog"],
        summary: "One collection",
        parameters: [pathParam("slug", "Collection slug")],
        responses: { "200": { description: "Collection" }, "404": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/catalog/search/suggest": {
      get: {
        tags: ["Catalog"],
        summary: "Search suggestions",
        description: "If q is shorter than 2 characters, returns trending products and popular searches.",
        parameters: [q("q", "Search text")],
        responses: { "200": { description: "{ products, categories, collections, popular }" } },
      },
    },
    "/api/v1/cart": {
      get: {
        tags: ["Cart"],
        summary: "Saved cart",
        security: [{ customerBearer: [] }],
        responses: { "200": { description: "{ items: [{ variantId, quantity }], couponCode }" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      put: {
        tags: ["Cart"],
        summary: "Replace the saved cart",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({
          type: "object",
          required: ["items"],
          properties: {
            items: { type: "array", maxItems: 50, items: { $ref: "#/components/schemas/CartItem" } },
            couponCode: { type: "string", nullable: true },
          },
        }),
        responses: { "200": { description: "Updated cart" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/api/v1/cart/merge": {
      post: {
        tags: ["Cart"],
        summary: "Merge a guest bag after login",
        description: "Quantities are the higher of the saved cart and the guest cart, capped at 10.",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({ type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/CartItem" } } } }),
        responses: { "200": { description: "Merged cart" } },
      },
    },
    "/api/v1/cart/quote": {
      post: {
        tags: ["Cart"],
        summary: "Price the saved cart",
        security: [{ customerBearer: [] }],
        responses: { "200": { description: "Same quote object as POST /api/v1/checkout/quote." } },
      },
    },
    "/api/v1/wishlist": {
      get: {
        tags: ["Wishlist"],
        summary: "Wishlist products",
        security: [{ customerBearer: [] }],
        responses: { "200": { description: "ProductCard[]" } },
      },
      post: {
        tags: ["Wishlist"],
        summary: "Add a product",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({ type: "object", required: ["productId"], properties: { productId: { type: "string" } } }),
        responses: { "201": { description: "{ ok: true }" } },
      },
    },
    "/api/v1/wishlist/merge": {
      post: {
        tags: ["Wishlist"],
        summary: "Merge guest product ids after login",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({ type: "object", required: ["productIds"], properties: { productIds: { type: "array", maxItems: 100, items: { type: "string" } } } }),
        responses: { "200": { description: "{ productIds: string[] }" } },
      },
    },
    "/api/v1/wishlist/{productId}": {
      delete: {
        tags: ["Wishlist"],
        summary: "Remove a product",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("productId", "Product id")],
        responses: { "200": { description: "{ ok: true }" } },
      },
    },
    "/api/v1/account/profile": {
      get: {
        tags: ["Account"],
        summary: "Profile",
        security: [{ customerBearer: [] }],
        responses: { "200": { description: "Customer", content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } } },
      },
      patch: {
        tags: ["Account"],
        summary: "Update profile",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string", nullable: true },
            dateOfBirth: { type: "string", format: "date-time", nullable: true },
            anniversary: { type: "string", format: "date-time", nullable: true },
            gender: { type: "string", nullable: true },
            acceptsMarketing: { type: "boolean" },
          },
        }),
        responses: { "200": { description: "Updated customer" } },
      },
    },
    "/api/v1/account/password": {
      post: {
        tags: ["Account"],
        summary: "Change password",
        description: "Signs out other sessions and returns a new refreshToken for this device.",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({
          type: "object",
          required: ["newPassword"],
          properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 8 } },
        }),
        responses: { "200": { description: "{ ok: true, refreshToken }" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/account/loyalty": {
      get: {
        tags: ["Account"],
        summary: "Loyalty balance and last 50 ledger rows",
        security: [{ customerBearer: [] }],
        responses: { "200": { description: "{ balance, ledger }" } },
      },
    },
    "/api/v1/account/addresses": {
      get: {
        tags: ["Account"],
        summary: "Saved addresses",
        security: [{ customerBearer: [] }],
        responses: { "200": { description: "Address[]" } },
      },
      post: {
        tags: ["Account"],
        summary: "Add an address",
        security: [{ customerBearer: [] }],
        requestBody: jsonBody({ $ref: "#/components/schemas/Address" }),
        responses: { "201": { description: "Created address" } },
      },
    },
    "/api/v1/account/addresses/{id}": {
      patch: {
        tags: ["Account"],
        summary: "Update an address",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("id", "Address id")],
        requestBody: jsonBody({ $ref: "#/components/schemas/Address" }),
        responses: { "200": { description: "Updated address" }, "404": { $ref: "#/components/responses/Error" } },
      },
      delete: {
        tags: ["Account"],
        summary: "Delete an address",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("id", "Address id")],
        responses: { "200": { description: "{ ok: true }" } },
      },
    },
    "/api/v1/account/orders": {
      get: {
        tags: ["Account"],
        summary: "Order history",
        security: [{ customerBearer: [] }],
        parameters: [q("page", "Page"), q("limit", "Page size")],
        responses: { "200": { description: "{ items, meta }. Each item includes statusLabel and a short item list." } },
      },
    },
    "/api/v1/account/orders/{orderNumber}": {
      get: {
        tags: ["Account"],
        summary: "Order detail",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("orderNumber", "Order number, for example AJ10001")],
        responses: { "200": { description: "Order with items, public timeline, shipments, and refunds." }, "404": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/account/orders/{orderNumber}/cancel": {
      post: {
        tags: ["Account"],
        summary: "Cancel a pending or confirmed order",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("orderNumber", "Order number")],
        requestBody: jsonBody({ type: "object", properties: { reason: { type: "string", maxLength: 300 } } }),
        responses: { "200": { description: "{ ok, message }" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/account/orders/{orderNumber}/return": {
      post: {
        tags: ["Account"],
        summary: "Request a return within 30 days of delivery",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("orderNumber", "Order number")],
        requestBody: jsonBody({ type: "object", required: ["reason"], properties: { reason: { type: "string", minLength: 3, maxLength: 500 } } }),
        responses: { "200": { description: "{ ok, message }" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/account/orders/{orderNumber}/invoice": {
      get: {
        tags: ["Account"],
        summary: "Download the invoice PDF",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("orderNumber", "Order number")],
        responses: { "200": { description: "application/pdf" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/uploads/review": {
      post: {
        tags: ["Account"],
        summary: "Upload a review photo",
        description: "multipart/form-data field name `file`. JPG, PNG, or WebP, max 5 MB.",
        security: [{ customerBearer: [] }],
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } },
        },
        responses: { "201": { description: "{ url }" } },
      },
    },
    "/api/v1/checkout/quote": {
      post: {
        tags: ["Checkout"],
        summary: "Price a bag before checkout",
        description: "Public. Send the customer bearer token to apply loyalty points and group discounts. Returns lines, coupon, shipping options, COD, gift wrap, tax split, and total.",
        security: [{ customerBearer: [] }, {}],
        requestBody: jsonBody({ $ref: "#/components/schemas/QuoteRequest" }),
        responses: { "200": { description: "Quote" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/checkout/offers": {
      get: { tags: ["Checkout"], summary: "Public coupon codes", responses: { "200": { description: "Active public coupons." } } },
    },
    "/api/v1/checkout/orders": {
      post: {
        tags: ["Checkout"],
        summary: "Place an order",
        description: "Guest checkout is allowed when the store setting is on. COD returns the order. Razorpay returns order plus a razorpay object (keyId, orderId, amount in paise, currency, prefill) to open the checkout SDK. source is recorded as WEB.",
        security: [{ customerBearer: [] }, {}],
        requestBody: jsonBody({
          allOf: [
            { $ref: "#/components/schemas/QuoteRequest" },
            {
              type: "object",
              required: ["paymentMethod", "email", "phone", "shippingAddress"],
              properties: {
                paymentMethod: { type: "string", enum: ["RAZORPAY", "COD"] },
                email: { type: "string", format: "email" },
                phone: { type: "string" },
                shippingAddress: { $ref: "#/components/schemas/Address" },
                billingAddress: { $ref: "#/components/schemas/Address" },
                giftMessage: { type: "string", maxLength: 300, nullable: true },
                customerNote: { type: "string", maxLength: 500, nullable: true },
                saveAddress: { type: "boolean", description: "Save shipping address when signed in." },
                acceptsMarketing: { type: "boolean" },
              },
            },
          ],
        }),
        responses: { "201": { description: "{ order, razorpay? }" }, "400": { $ref: "#/components/responses/Error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/api/v1/checkout/orders/{orderNumber}/pay": {
      post: {
        tags: ["Checkout"],
        summary: "Retry Razorpay for an unpaid order",
        security: [{ customerBearer: [] }],
        parameters: [pathParam("orderNumber", "Order number")],
        requestBody: jsonBody({ type: "object", properties: { email: { type: "string", description: "Required for guests, must match the order email." } } }),
        responses: { "200": { description: "{ order, razorpay }" } },
      },
    },
    "/api/v1/checkout/razorpay/verify": {
      post: {
        tags: ["Checkout"],
        summary: "Verify a Razorpay payment and mark the order paid",
        description: "Send the three values from the Razorpay success handler.",
        requestBody: jsonBody({
          type: "object",
          required: ["razorpay_order_id", "razorpay_payment_id", "razorpay_signature"],
          properties: {
            razorpay_order_id: { type: "string" },
            razorpay_payment_id: { type: "string" },
            razorpay_signature: { type: "string" },
            method: { type: "string" },
          },
        }),
        responses: { "200": { description: "{ ok: true, orderNumber }" }, "400": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/checkout/razorpay/failed": {
      post: {
        tags: ["Checkout"],
        summary: "Record a failed Razorpay attempt",
        requestBody: jsonBody({
          type: "object",
          required: ["razorpay_order_id"],
          properties: { razorpay_order_id: { type: "string" }, code: { type: "string" }, description: { type: "string" } },
        }),
        responses: { "200": { description: "{ ok: true }" } },
      },
    },
    "/api/v1/checkout/track": {
      get: {
        tags: ["Checkout"],
        summary: "Track an order without signing in",
        parameters: [q("order", "Order number"), q("contact", "Email or phone used on the order")],
        responses: { "200": { description: "Status, items, public events, shipments." }, "404": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/config": {
      get: {
        tags: ["Content"],
        summary: "Mobile app configuration",
        description:
          "Call this once when the app starts. Envelope is { statusCode, success, message, data, timestamp }. Branding, phones, Razorpay, COD, loyalty and legal URLs come from store settings. plans is always an empty array: Ananta sells jewellery, not subscriptions. ios_iap_enabled is false because checkout uses Razorpay or COD.",
        responses: {
          "200": {
            description: "App configuration",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    statusCode: { type: "integer", example: 200 },
                    success: { type: "boolean", example: true },
                    message: { type: "string" },
                    data: { type: "object" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/settings/public": {
      get: {
        tags: ["Content"],
        summary: "Public store config",
        description: "Store profile, SEO, checkout rules (free shipping, COD, gift wrap, guest checkout), loyalty rates, and whether Razorpay is enabled (includes key id when live).",
        responses: { "200": { description: "Public settings" } },
      },
    },
    "/api/v1/content/banners": {
      get: {
        tags: ["Content"],
        summary: "Active banners",
        parameters: [q("placement", "HOME_HERO | HOME_STRIP | HOME_PROMO | GIFTING | or another placement")],
        responses: { "200": { description: "Banner[]" } },
      },
    },
    "/api/v1/content/blog": {
      get: {
        tags: ["Content"],
        summary: "Published posts",
        parameters: [q("page", "Page"), q("limit", "Page size"), q("type", "Post type"), q("tag", "Tag")],
        responses: { "200": { description: "{ items, meta }" } },
      },
    },
    "/api/v1/content/blog/{slug}": {
      get: {
        tags: ["Content"],
        summary: "One post plus three more",
        parameters: [pathParam("slug", "Post slug")],
        responses: { "200": { description: "Post" }, "404": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/content/newsletter": {
      post: {
        tags: ["Content"],
        summary: "Subscribe to the newsletter",
        requestBody: jsonBody({
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", format: "email" }, name: { type: "string" }, source: { type: "string", example: "mobile" } },
        }),
        responses: { "201": { description: "{ ok, message }" } },
      },
    },
    "/api/v1/content/contact": {
      post: {
        tags: ["Content"],
        summary: "Contact form",
        requestBody: jsonBody({
          type: "object",
          required: ["name", "email", "message"],
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            subject: { type: "string" },
            message: { type: "string", minLength: 10 },
          },
        }),
        responses: { "201": { description: "{ ok, message }" } },
      },
    },
    "/api/v1/content/track": {
      post: {
        tags: ["Content"],
        summary: "Anonymous daily counter",
        requestBody: jsonBody({
          type: "object",
          required: ["event"],
          properties: { event: { type: "string", enum: ["visit", "product_view", "add_to_cart", "checkout"] } },
        }),
        responses: { "204": { description: "No body" } },
      },
    },
    "/api/v1/content/pincode/{pincode}": {
      get: {
        tags: ["Content"],
        summary: "Delivery check for a 6-digit pincode",
        parameters: [pathParam("pincode", "6-digit Indian pincode"), q("variantId", "Optional. Prices shipping for one unit of this variant.")],
        responses: { "200": { description: "{ serviceable, codAvailable, minDays, maxDays, estimatedDelivery, shippingFee, message, places }" } },
      },
    },
    "/api/v1/webhooks/razorpay": {
      post: { tags: ["Checkout"], summary: "Razorpay webhook (server to server)", description: "Raw body, signature header. Not called by the mobile app.", responses: { "200": { description: "Accepted" } } },
    },
    "/api/v1/webhooks/shipping/{code}": {
      post: {
        tags: ["Checkout"],
        summary: "Courier webhook (server to server)",
        parameters: [pathParam("code", "Shipping partner code")],
        responses: { "200": { description: "Accepted" } },
      },
    },
    ...adminPaths(),
  },
} as const;

function jsonBody(schema: object, example?: object) {
  return {
    required: true,
    content: { "application/json": { schema, ...(example ? { example } : {}) } },
  };
}

function q(name: string, description: string) {
  return { name, in: "query" as const, schema: { type: "string" }, description };
}

function pathParam(name: string, description: string) {
  return { name, in: "path" as const, required: true, schema: { type: "string" }, description };
}

/** Admin console routes. Listed so the full API is visible; the mobile app does not call these. */
function adminPaths() {
  const rows: [string, string, string][] = [
    ["post", "/api/v1/admin/auth/login", "Admin sign in. Body: { email, password }. Returns accessToken, refreshToken, user."],
    ["post", "/api/v1/admin/auth/refresh", "Rotate admin refresh token. Body: { refreshToken }."],
    ["post", "/api/v1/admin/auth/logout", "Revoke admin refresh token."],
    ["get", "/api/v1/admin/auth/me", "Current admin user and permissions."],
    ["patch", "/api/v1/admin/auth/me", "Update admin profile or password."],
    ["post", "/api/v1/admin/auth/me/avatar", "Upload admin avatar. multipart field file."],
    ["get", "/api/v1/admin/dashboard", "Dashboard metrics. Query: range."],
    ["get", "/api/v1/admin/search", "Global admin search."],
    ["get", "/api/v1/admin/notifications", "Admin notifications."],
    ["post", "/api/v1/admin/notifications/read-all", "Mark all notifications read."],
    ["post", "/api/v1/admin/notifications/{id}/read", "Mark one notification read."],
    ["post", "/api/v1/admin/notifications/{id}/unread", "Mark one notification unread."],
    ["get", "/api/v1/admin/counts", "Sidebar badge counts."],
    ["get", "/api/v1/admin/products", "List products."],
    ["get", "/api/v1/admin/products/export", "Export products."],
    ["get", "/api/v1/admin/products/import-template", "Product import template."],
    ["post", "/api/v1/admin/products/import", "Import products. multipart field file."],
    ["post", "/api/v1/admin/products/bulk", "Bulk product actions."],
    ["get", "/api/v1/admin/products/{id}", "Product detail."],
    ["post", "/api/v1/admin/products", "Create a product."],
    ["patch", "/api/v1/admin/products/{id}", "Update a product."],
    ["post", "/api/v1/admin/products/{id}/duplicate", "Duplicate a product."],
    ["delete", "/api/v1/admin/products/{id}", "Delete a product."],
    ["post", "/api/v1/admin/categories/reorder", "Reorder categories."],
    ["get", "/api/v1/admin/collections/{id}/products", "Products in a collection."],
    ["put", "/api/v1/admin/collections/{id}/products", "Replace products in a collection."],
    ["get", "/api/v1/admin/reviews", "Moderate reviews."],
    ["patch", "/api/v1/admin/reviews/{id}", "Update a review."],
    ["post", "/api/v1/admin/reviews/bulk", "Bulk review actions."],
    ["delete", "/api/v1/admin/reviews/{id}", "Delete a review."],
    ["get", "/api/v1/admin/inventory", "Stock by variant."],
    ["get", "/api/v1/admin/inventory/low-stock", "Low stock variants."],
    ["post", "/api/v1/admin/inventory/adjust", "Adjust stock."],
    ["post", "/api/v1/admin/inventory/bulk", "Bulk stock update."],
    ["post", "/api/v1/admin/inventory/import", "Import stock. multipart field file."],
    ["get", "/api/v1/admin/inventory/movements", "Stock movements."],
    ["get", "/api/v1/admin/inventory/variants/search", "Search variants."],
    ["get", "/api/v1/admin/inventory/transfers", "Warehouse transfers."],
    ["get", "/api/v1/admin/inventory/transfers/{id}", "One transfer."],
    ["post", "/api/v1/admin/inventory/transfers", "Create a transfer."],
    ["post", "/api/v1/admin/inventory/transfers/{id}/dispatch", "Dispatch a transfer."],
    ["post", "/api/v1/admin/inventory/transfers/{id}/receive", "Receive a transfer."],
    ["post", "/api/v1/admin/inventory/transfers/{id}/cancel", "Cancel a transfer."],
    ["get", "/api/v1/admin/orders", "List orders."],
    ["get", "/api/v1/admin/orders/status-counts", "Order counts by status."],
    ["post", "/api/v1/admin/orders/bulk-status", "Bulk status change."],
    ["post", "/api/v1/admin/orders/quote", "Quote a manual order."],
    ["post", "/api/v1/admin/orders", "Create a manual order."],
    ["get", "/api/v1/admin/orders/{id}", "Order detail."],
    ["patch", "/api/v1/admin/orders/{id}", "Update an order."],
    ["patch", "/api/v1/admin/orders/{id}/status", "Change order status."],
    ["post", "/api/v1/admin/orders/{id}/notes", "Add an internal note."],
    ["post", "/api/v1/admin/orders/{id}/mark-paid", "Mark an order paid."],
    ["post", "/api/v1/admin/orders/{id}/refunds", "Create a refund."],
    ["get", "/api/v1/admin/orders/{id}/invoice", "Invoice PDF."],
    ["get", "/api/v1/admin/orders/{id}/packing-slip", "Packing slip PDF."],
    ["get", "/api/v1/admin/customers", "List customers."],
    ["get", "/api/v1/admin/customers/tags", "Customer tags."],
    ["get", "/api/v1/admin/customers/{id}", "Customer detail."],
    ["post", "/api/v1/admin/customers", "Create a customer."],
    ["patch", "/api/v1/admin/customers/{id}", "Update a customer."],
    ["post", "/api/v1/admin/customers/{id}/loyalty", "Adjust loyalty points."],
    ["post", "/api/v1/admin/customers/bulk", "Bulk customer actions."],
    ["get", "/api/v1/admin/shipping/shipments", "Shipments."],
    ["get", "/api/v1/admin/shipping/queue", "Orders waiting to ship."],
    ["get", "/api/v1/admin/shipping/shipments/{id}", "One shipment."],
    ["post", "/api/v1/admin/orders/{id}/shipments", "Create a shipment for an order."],
    ["post", "/api/v1/admin/shipping/bulk-create", "Create shipments in bulk."],
    ["get", "/api/v1/admin/shipping/shipments/{id}/label", "Shipping label."],
    ["post", "/api/v1/admin/shipping/shipments/{id}/sync", "Sync one shipment."],
    ["post", "/api/v1/admin/shipping/sync-all", "Sync all shipments."],
    ["post", "/api/v1/admin/shipping/shipments/{id}/status", "Set shipment status."],
    ["post", "/api/v1/admin/shipping/shipments/{id}/pickup", "Request pickup."],
    ["post", "/api/v1/admin/shipping/shipments/{id}/cancel", "Cancel a shipment."],
    ["get", "/api/v1/admin/shipping/ndr", "Non-delivery reports."],
    ["patch", "/api/v1/admin/shipping/ndr/{id}", "Update an NDR."],
    ["post", "/api/v1/admin/shipping/zones/{id}/rates", "Add a shipping rate."],
    ["patch", "/api/v1/admin/shipping/rates/{id}", "Update a shipping rate."],
    ["delete", "/api/v1/admin/shipping/rates/{id}", "Delete a shipping rate."],
    ["get", "/api/v1/admin/shipping/partners", "Courier partners."],
    ["patch", "/api/v1/admin/shipping/partners/{id}", "Update a courier partner."],
    ["post", "/api/v1/admin/shipping/partners/{id}/test", "Test a courier connection."],
    ["get", "/api/v1/admin/payments/summary", "Payment summary."],
    ["get", "/api/v1/admin/payments/transactions", "Payment transactions."],
    ["get", "/api/v1/admin/payments/transactions/{id}", "One transaction."],
    ["post", "/api/v1/admin/payments/transactions/{id}/refresh", "Refresh a transaction from Razorpay."],
    ["get", "/api/v1/admin/payments/refunds", "Refunds."],
    ["get", "/api/v1/admin/payments/settlements", "Settlements."],
    ["post", "/api/v1/admin/payments/settlements/sync", "Sync settlements."],
    ["get", "/api/v1/admin/payments/settlements/{id}", "One settlement."],
    ["get", "/api/v1/admin/marketing/coupons/{id}/redemptions", "Coupon redemptions."],
    ["get", "/api/v1/admin/marketing/flash-sales", "Flash sales."],
    ["get", "/api/v1/admin/marketing/flash-sales/{id}", "One flash sale."],
    ["post", "/api/v1/admin/marketing/flash-sales", "Create a flash sale."],
    ["patch", "/api/v1/admin/marketing/flash-sales/{id}", "Update a flash sale."],
    ["delete", "/api/v1/admin/marketing/flash-sales/{id}", "Delete a flash sale."],
    ["get", "/api/v1/admin/marketing/email-templates", "Email templates."],
    ["get", "/api/v1/admin/marketing/email-templates/{id}", "One email template."],
    ["patch", "/api/v1/admin/marketing/email-templates/{id}", "Update an email template."],
    ["post", "/api/v1/admin/marketing/email-templates/preview", "Preview an email template."],
    ["post", "/api/v1/admin/marketing/email-templates/{id}/test", "Send a test email."],
    ["get", "/api/v1/admin/marketing/newsletter", "Newsletter subscribers."],
    ["patch", "/api/v1/admin/marketing/newsletter/{id}", "Update a subscriber."],
    ["delete", "/api/v1/admin/marketing/newsletter/{id}", "Delete a subscriber."],
    ["get", "/api/v1/admin/marketing/abandoned-carts", "Abandoned carts."],
    ["post", "/api/v1/admin/marketing/abandoned-carts/{id}/remind", "Send a cart reminder."],
    ["get", "/api/v1/admin/marketing/inquiries", "Contact enquiries."],
    ["patch", "/api/v1/admin/marketing/inquiries/{id}", "Update an enquiry."],
    ["delete", "/api/v1/admin/marketing/inquiries/{id}", "Delete an enquiry."],
    ["get", "/api/v1/admin/reports/sales", "Sales report."],
    ["get", "/api/v1/admin/reports/products", "Product report."],
    ["get", "/api/v1/admin/reports/categories", "Category report."],
    ["get", "/api/v1/admin/reports/customers", "Customer report."],
    ["get", "/api/v1/admin/reports/inventory", "Inventory report."],
    ["get", "/api/v1/admin/reports/tax", "Tax report."],
    ["get", "/api/v1/admin/reports/payments", "Payments report."],
    ["get", "/api/v1/admin/reports/coupons", "Coupon report."],
    ["get", "/api/v1/admin/settings", "All settings."],
    ["post", "/api/v1/admin/settings/test-email", "Send a test email."],
    ["post", "/api/v1/admin/settings/test-message", "Send a test SMS/WhatsApp."],
    ["get", "/api/v1/admin/settings/{key}", "One settings group."],
    ["put", "/api/v1/admin/settings/{key}", "Replace a settings group."],
    ["get", "/api/v1/admin/users", "Admin users."],
    ["post", "/api/v1/admin/users", "Create an admin user."],
    ["patch", "/api/v1/admin/users/{id}", "Update an admin user."],
    ["delete", "/api/v1/admin/users/{id}", "Delete an admin user."],
    ["get", "/api/v1/admin/permissions", "Permission catalogue."],
    ["get", "/api/v1/admin/roles", "Roles."],
    ["post", "/api/v1/admin/roles", "Create a role."],
    ["patch", "/api/v1/admin/roles/{id}", "Update a role."],
    ["delete", "/api/v1/admin/roles/{id}", "Delete a role."],
    ["get", "/api/v1/admin/activity-logs", "Audit log."],
    ["get", "/api/v1/admin/media", "Media library."],
    ["post", "/api/v1/admin/media", "Upload media. multipart field files."],
    ["get", "/api/v1/admin/media/{id}/usage", "Where a media file is used."],
    ["patch", "/api/v1/admin/media/{id}", "Update media metadata."],
    ["delete", "/api/v1/admin/media/{id}", "Delete media."],
  ];
  const crud = [
    "/api/v1/admin/categories",
    "/api/v1/admin/collections",
    "/api/v1/admin/tags",
    "/api/v1/admin/inventory/warehouses",
    "/api/v1/admin/customer-groups",
    "/api/v1/admin/marketing/coupons",
    "/api/v1/admin/marketing/banners",
    "/api/v1/admin/marketing/posts",
    "/api/v1/admin/shipping/zones",
  ];
  const paths: Record<string, Record<string, unknown>> = {};
  const ensure = (path: string) => (paths[path] ??= {});
  for (const [method, path, summary] of rows) {
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => pathParam(m[1], m[1]));
    ensure(path)[method] = {
      tags: ["Admin"],
      summary,
      security: path.startsWith("/api/v1/admin/auth/login") || path.endsWith("/auth/refresh") || path.endsWith("/auth/logout") ? [] : [{ adminBearer: [] }],
      ...(parameters.length ? { parameters } : {}),
      responses: { "200": { description: "OK" }, "400": { $ref: "#/components/responses/Error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
    };
  }
  for (const base of crud) {
    const name = base.split("/").pop();
    ensure(base).get = {
      tags: ["Admin"],
      summary: `List ${name}`,
      security: [{ adminBearer: [] }],
      parameters: [q("page", "Page"), q("limit", "Page size"), q("q", "Search")],
      responses: { "200": { description: "List" } },
    };
    ensure(base).post = {
      tags: ["Admin"],
      summary: `Create ${name}`,
      security: [{ adminBearer: [] }],
      responses: { "201": { description: "Created" } },
    };
    ensure(`${base}/{id}`).get = {
      tags: ["Admin"],
      summary: `Get ${name}`,
      security: [{ adminBearer: [] }],
      parameters: [pathParam("id", "Id")],
      responses: { "200": { description: "Record" } },
    };
    ensure(`${base}/{id}`).patch = {
      tags: ["Admin"],
      summary: `Update ${name}`,
      security: [{ adminBearer: [] }],
      parameters: [pathParam("id", "Id")],
      responses: { "200": { description: "Updated" } },
    };
    ensure(`${base}/{id}`).delete = {
      tags: ["Admin"],
      summary: `Delete ${name}`,
      security: [{ adminBearer: [] }],
      parameters: [pathParam("id", "Id")],
      responses: { "200": { description: "Deleted" } },
    };
  }
  return paths;
}
