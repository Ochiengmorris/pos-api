# POS API

A point-of-sale backend for a Kenyan retail shop, built with **NestJS**, **Prisma** and **PostgreSQL**.

It handles the full till workflow: products and stock, multi-method checkout (cash, M-Pesa STK push, card), VAT-inclusive pricing, receipts, voids, reporting, and KRA **eTIMS** tax-invoice queuing.

> **Status:** the API is feature-rich but the live KRA connection is not built yet. eTIMS runs against a **mock provider** only (nothing is filed with KRA). See [Known limitations](#known-limitations).

---

## Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Quick start](#quick-start)
4. [Configuration](#configuration)
5. [Architecture](#architecture)
6. [Authentication and roles](#authentication-and-roles)
7. [API conventions](#api-conventions)
8. [Endpoint reference](#endpoint-reference)
9. [Core flows in detail](#core-flows-in-detail)
10. [Data model](#data-model)
11. [Background jobs](#background-jobs)
12. [Testing](#testing)
13. [Deployment checklist](#deployment-checklist)
14. [Known limitations](#known-limitations)
15. [Project structure](#project-structure)

---

## Features

- **Users and roles** — `ADMIN`, `MANAGER`, `CASHIER`; JWT login; forced password change for new or admin-reset accounts.
- **Catalogue** — products with SKU, barcode, category, price, cost, reorder level; barcode/SKU scanner lookup.
- **Inventory** — restock, adjust, physical count, full movement ledger, stock summary. Stock can never go negative, even under concurrent sales.
- **Checkout** — VAT-inclusive pricing, split payments (up to 5), cash change calculation, idempotent retries via `clientRequestId`, per-line cost snapshot for profit reporting.
- **M-Pesa (Daraja STK push)** — initiate, poll, callback handling, self-healing status queries, reconciliation of money received without a sale.
- **Receipts** — store details, tax breakdown by KRA class, payments, change, eTIMS status and signature data.
- **Voids** — manager-only, atomic, restores stock, reverses the tax invoice (cancel if unsent, credit note if accepted).
- **eTIMS** — durable job queue, retry with backoff, uncertain-outcome reconciliation, manual resolution, audit trail, alerts, tax-class management.
- **Reports** — dashboard, KPIs with period-over-period change, trend, top products, categories, payment methods, VAT, cashiers, end-of-shift summary. All in the business timezone.
- **Operations** — rate limiting, Helmet, CORS, health endpoint, Swagger docs, audit log for tax-relevant changes.

## Tech stack

| Area          | Choice                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| Framework     | NestJS 12 (Express)                                                     |
| Language      | TypeScript (strict)                                                     |
| Database      | PostgreSQL 16 via Prisma 6                                              |
| Auth          | Passport JWT, bcrypt (cost 12)                                          |
| Validation    | class-validator / class-transformer (whitelist + forbid unknown fields) |
| Scheduling    | `@nestjs/schedule` (cron and intervals)                                 |
| Rate limiting | `@nestjs/throttler`                                                     |
| Docs          | `@nestjs/swagger` at `/docs`                                            |
| Tests         | Jest 30, ts-jest, supertest                                             |
| Lint / format | oxlint (type-aware), Prettier                                           |

## Quick start

### Prerequisites

- A current Node.js LTS (the project's typings target Node 24)
- npm
- Docker (for the bundled Postgres), or your own PostgreSQL 16

### 1. Install

```bash
npm install
```

### 2. Start the database

```bash
docker compose up -d db
```

This starts Postgres on **host port 5438** (user `pos`, password `pos`, database `pos`).

### 3. Create `.env`

Minimum for local development:

```dotenv
DATABASE_URL="postgresql://pos:pos@localhost:5438/pos?schema=public"
JWT_SECRET="replace-with-a-long-random-string"
FRONTEND_ORIGIN="http://localhost:3000"
```

See [Configuration](#configuration) for everything else.

### 4. Migrate and seed

```bash
npx prisma migrate deploy      # apply migrations
npx prisma generate            # generate the Prisma client
npx ts-node prisma/seed.ts     # demo data (see below)
```

`prisma/seed.ts` creates:

| Account  | Default email                                | Default password |
| -------- | -------------------------------------------- | ---------------- |
| Admin    | `admin@shop.local`                           | `ChangeMe123!`   |
| Manager  | `manager@shop.local`                         | `Passw0rd!123`   |
| Cashiers | `cashier1@shop.local`, `cashier2@shop.local` | `Passw0rd!123`   |

plus sample categories and products. Override with `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_STAFF_PASSWORD`. Set `SEED_DEMO_SALES=true` to also generate reproducible demo sales.

With `NODE_ENV=production` the seed creates **only the admin** and **requires** `SEED_ADMIN_PASSWORD`.

`prisma/seed-initial.ts` is a lighter alternative that creates a single admin (`SEED_ADMIN_EMAIL`, default `admin@duka.home`).

### 5. Run

```bash
npm run start:dev     # watch mode
npm run start         # one-off
npm run build && npm run start:prod
```

The API listens on `http://localhost:4000` (or `PORT`). All routes are under **`/api/v1`**, except `/health`.

- Swagger UI: `http://localhost:4000/docs` (non-production, or when `ENABLE_DOCS=true`)
- Health: `http://localhost:4000/health`

### 6. Try it

```bash
curl -s http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@shop.local","password":"ChangeMe123!"}'
```

Use the returned `accessToken` as `Authorization: Bearer <token>`.

## Configuration

All settings come from environment variables (loaded from `.env` via `@nestjs/config`).

### Core

| Variable            | Default                 | Description                                                                      |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`      | — (required)            | PostgreSQL connection string                                                     |
| `JWT_SECRET`        | — (required)            | Token signing secret. Use 32+ random characters in production                    |
| `JWT_EXPIRES_IN`    | `12h`                   | Token lifetime                                                                   |
| `PORT`              | `4000`                  | HTTP port                                                                        |
| `NODE_ENV`          | —                       | `production` disables Swagger and dev-only endpoints                             |
| `FRONTEND_ORIGIN`   | `http://localhost:3000` | Allowed CORS origin(s), comma-separated                                          |
| `TRUST_PROXY`       | `false`                 | Set `true` behind nginx or a load balancer so rate limiting sees real client IPs |
| `ENABLE_DOCS`       | `false`                 | Force Swagger on in production                                                   |
| `THROTTLE_DISABLED` | `false`                 | Turns off rate limiting (useful for tests)                                       |
| `BUSINESS_TZ`       | `Africa/Nairobi`        | Timezone used for report day boundaries                                          |
| `RECEIPT_PREFIX`    | `RCP`                   | Prefix for receipt numbers (`RCP-000123`)                                        |

### Store defaults

Used once to create the store settings row on first read. After that, edit via `PATCH /settings/store`.

`STORE_NAME` (`My Shop`), `STORE_ADDRESS`, `STORE_PHONE`, `STORE_TAX_PIN`.

### M-Pesa (Daraja)

| Variable                                       | Default                 | Description                                                        |
| ---------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `MPESA_ENV`                                    | `sandbox`               | `sandbox` or `production`                                          |
| `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` | —                       | Daraja app credentials                                             |
| `MPESA_SHORTCODE`                              | —                       | Business shortcode                                                 |
| `MPESA_PASSKEY`                                | —                       | STK push passkey                                                   |
| `MPESA_PARTY_B`                                | shortcode               | Receiving party (till number if different)                         |
| `MPESA_TRANSACTION_TYPE`                       | `CustomerPayBillOnline` | Use `CustomerBuyGoodsOnline` for tills                             |
| `MPESA_CALLBACK_BASE_URL`                      | —                       | Public HTTPS base URL of this API                                  |
| `MPESA_CALLBACK_SECRET`                        | —                       | Secret embedded in the callback URL path (24+ chars in production) |
| `MPESA_VERIFY_CALLBACKS`                       | `false`                 | Double-check each success callback with a Daraja status query      |
| `MPESA_ALLOW_MANUAL_REFERENCE`                 | `false`                 | Allow typing in an M-Pesa code instead of using STK                |

M-Pesa is considered **configured** only when key, secret, shortcode, passkey, callback base URL and callback secret are all set. Otherwise `POST /payments/mpesa/stk` returns 503.

### eTIMS

| Variable                  | Default     | Description                                                                                         |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `ETIMS_PROVIDER`          | `disabled`  | `disabled`, `mock`, or `oscu` (not implemented; the app refuses to start with it)                   |
| `ETIMS_ENVIRONMENT`       | `SANDBOX`   | `SANDBOX` or `PRODUCTION` (ignored for the mock, which reports `MOCK`)                              |
| `ETIMS_TIN`               | —           | Your KRA PIN                                                                                        |
| `ETIMS_BHF_ID`            | `00`        | Branch ID                                                                                           |
| `ETIMS_TAXBL_BASIS`       | `inclusive` | `inclusive` or `exclusive` taxable-amount basis                                                     |
| `ETIMS_FIRST_INVOICE_NO`  | `1`         | Starting invoice number for the sequence                                                            |
| `ETIMS_MAX_ATTEMPTS`      | `20`        | Attempts before an invoice is marked as needing attention                                           |
| `ETIMS_WORKER`            | `on`        | Set `off` to stop the background sender on this instance                                            |
| `ETIMS_STUCK_MINUTES`     | `15`        | Pending longer than this counts as "stuck"                                                          |
| `ETIMS_ALERT_WEBHOOK_URL` | —           | Receives `{ "text": "..." }` JSON when an invoice needs attention                                   |
| `ETIMS_QR_URL_TEMPLATE`   | —           | QR URL template                                                                                     |
| `MOCK_ETIMS_MODE`         | `ok`        | Mock behaviour: `ok`, `down`, `timeout`, `reject`, `flaky`, `lost_response`, `lost_response_strict` |

## Architecture

```mermaid
flowchart LR
  FE[Frontend / till] -->|JWT| API
  subgraph API[NestJS API]
    G[Guards: Throttler → JWT → PasswordChange → Roles]
    C[Controllers] --> S[Services]
    S --> P[(PostgreSQL via Prisma)]
    W[eTIMS worker<br/>every 5 s] --> P
    CR[M-Pesa stale-payment cron<br/>every minute] --> P
  end
  S -->|STK push / query| D[Safaricom Daraja]
  D -->|callback| API
  W -->|submit invoice| K[(KRA eTIMS<br/>mock today)]
```

### Request pipeline

Every request passes four global guards in order:

1. **ThrottlerGuard** — 120 requests/minute/IP by default (login: 5/minute).
2. **JwtAuthGuard** — validates the bearer token; skipped for `@Public()` routes. The user is reloaded from the database on every request, so deactivation and role changes take effect immediately.
3. **PasswordChangeGuard** — if `mustChangePassword` is set, only `@AllowPendingPassword()` routes are reachable.
4. **RolesGuard** — enforces `@Roles(...)`.

Then the global `ValidationPipe` runs (`whitelist`, `forbidNonWhitelisted`, `transform`), and a `PrismaExceptionFilter` converts database errors into clean HTTP responses.

### Design principles worth knowing

- **Money is `Decimal`**, never floating point. Reports return money as strings.
- **Stock changes in exactly one place** (`InventoryService.applyChange`), always inside a transaction, with a conditional `UPDATE ... WHERE stockQty >= n` so the database itself prevents overselling.
- **Everything that must be atomic is in one transaction:** sale, items, payments, M-Pesa claim, stock deduction, stock movements, and the eTIMS invoice + job.
- **Snapshots on sale lines** (name, price, cost, tax rate, tax class) keep history correct after catalogue edits.
- **Outbox pattern for eTIMS:** the invoice job is created with the sale, then a worker sends it later. A KRA outage never blocks a sale.
- **Rates are data, not code:** VAT rates live in the `TaxType` table.

## Authentication and roles

`POST /auth/login` returns an `accessToken` (JWT) and the user object. Send it as `Authorization: Bearer <token>`.

| Role      | Can do                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CASHIER` | Sell, look up products, start/poll M-Pesa payments, view **own** sales and receipts, own shift report                   |
| `MANAGER` | Everything a cashier can, plus products, categories, inventory, voids, reports, M-Pesa reconciliation, eTIMS management |
| `ADMIN`   | Everything, plus users, store settings, tax rates, manual eTIMS data entry                                              |

Notes:

- `@Roles(Role.MANAGER)` means _manager or admin_. Admin always passes.
- Cashiers get **404** (not 403) for other people's sales and payments, so nothing leaks.
- Cashiers never see `costPrice` / `unitCost` in product or sale responses.
- New users, and users whose password was reset by an admin, have `mustChangePassword: true`. Until they call `PATCH /users/me/password`, every other endpoint returns `403` with `code: "PASSWORD_CHANGE_REQUIRED"`.
- Admins cannot deactivate themselves or change their own role.

## API conventions

**Base path:** `/api/v1` (health is `/health`).

**Pagination** — list endpoints accept `page` (default 1) and `limit`, and return:

```json
{
  "items": [],
  "meta": { "total": 120, "page": 1, "limit": 20, "pages": 6 }
}
```

| Endpoint group                           | Default limit | Max |
| ---------------------------------------- | ------------- | --- |
| users, sales, eTIMS invoices, tax review | 20            | 100 |
| products, inventory movements            | 50            | 200 |

**Errors** use Nest's standard shape:

```json
{
  "statusCode": 400,
  "message": "Insufficient stock for Soda: 2 available",
  "error": "Bad Request"
}
```

Validation failures return `message` as an array of strings. Database conflicts map to: `P2002` → 409 (duplicate), `P2025` → 404, `P2003` → 409 (referenced), `P2034` → 409 (retry).

**Dates**

- Report endpoints take business days as `YYYY-MM-DD` and interpret them in `BUSINESS_TZ`.
- List filters (`from`, `to` on sales, movements, invoices) take ISO-8601 timestamps and compare them literally.

**Receipt numbers** are formatted `PREFIX-000123`. Searching sales accepts `RCP-000123`, `000123` or `123`.

## Endpoint reference

Legend: 🔓 public · 👤 any signed-in user · 🧑‍💼 manager+ · 🛡️ admin only.

### Health

| Method | Path      | Access | Description                               |
| ------ | --------- | ------ | ----------------------------------------- |
| GET    | `/health` | 🔓     | Checks database connectivity. 503 if down |

### Auth

| Method | Path          | Access     | Description                                             |
| ------ | ------------- | ---------- | ------------------------------------------------------- |
| POST   | `/auth/login` | 🔓 (5/min) | Email + password → `{ accessToken, user }`              |
| GET    | `/auth/me`    | 👤         | Current user (works while a password change is pending) |

### Users

| Method | Path                  | Access | Description                                                                         |
| ------ | --------------------- | ------ | ----------------------------------------------------------------------------------- |
| PATCH  | `/users/me/password`  | 👤     | Change own password (`currentPassword`, `newPassword`). Clears `mustChangePassword` |
| POST   | `/users`              | 🛡️     | Create user. They must change password on first login                               |
| GET    | `/users`              | 🛡️     | List/search (`search`, `role`, `page`, `limit`)                                     |
| GET    | `/users/:id`          | 🛡️     | Get one                                                                             |
| PATCH  | `/users/:id`          | 🛡️     | Update email, name, role, `isActive`                                                |
| PATCH  | `/users/:id/password` | 🛡️     | Reset a password (forces change unless resetting your own)                          |

### Categories

| Method | Path              | Access | Description                               |
| ------ | ----------------- | ------ | ----------------------------------------- |
| GET    | `/categories`     | 👤     | List with product counts                  |
| POST   | `/categories`     | 🧑‍💼     | Create (case-insensitive unique name)     |
| PATCH  | `/categories/:id` | 🧑‍💼     | Rename                                    |
| DELETE | `/categories/:id` | 🧑‍💼     | Delete (blocked if it still has products) |

### Products

| Method | Path                     | Access | Description                                                                                              |
| ------ | ------------------------ | ------ | -------------------------------------------------------------------------------------------------------- |
| GET    | `/products`              | 👤     | List. Filters: `search` (name/SKU/barcode), `categoryId`, `lowStock`, `includeInactive`, `page`, `limit` |
| GET    | `/products/lookup/:code` | 👤     | Exact match on barcode, falling back to SKU (scanner endpoint)                                           |
| GET    | `/products/:id`          | 👤     | Get one                                                                                                  |
| POST   | `/products`              | 🧑‍💼     | Create. Optional `initialStock` is recorded as an "Opening stock" movement                               |
| PATCH  | `/products/:id`          | 🧑‍💼     | Update (including `isActive`). Tax-class changes are audit-logged                                        |

Product fields: `sku`, `barcode?`, `name`, `categoryId?`, `price` (VAT-inclusive), `costPrice?`, `taxTyCd` (A–E), `reorderLevel?`, `initialStock?`.

### Inventory (🧑‍💼 all)

| Method | Path                   | Description                                                                                         |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| POST   | `/inventory/restock`   | Add stock (`productId`, `quantity ≥ 1`, `reason?`) → `PURCHASE` movement                            |
| POST   | `/inventory/adjust`    | Signed correction (`quantity`, `reason ≥ 3 chars`) → `ADJUSTMENT`. Rejected if it would go negative |
| POST   | `/inventory/count`     | Set stock to a physical count (`countedQty`); records the difference under a row lock               |
| GET    | `/inventory/movements` | Ledger. Filters: `productId`, `type`, `from`, `to`                                                  |
| GET    | `/inventory/summary`   | Active products, units, stock value at cost and retail, out-of-stock and low-stock counts           |

### Sales

| Method | Path                 | Access | Description                                                                                                       |
| ------ | -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/sales`             | 👤     | Checkout (see [below](#checkout))                                                                                 |
| GET    | `/sales`             | 👤     | List. Filters: `status`, `cashierId` (ignored for cashiers), `receipt`, `from`, `to`. Cashiers see only their own |
| GET    | `/sales/:id`         | 👤     | Sale with items, payments, cashier, customer and `etims` status                                                   |
| GET    | `/sales/:id/receipt` | 👤     | Print-ready receipt payload                                                                                       |
| POST   | `/sales/:id/void`    | 🧑‍💼     | Void with a `reason`                                                                                              |

### M-Pesa

| Method | Path                          | Access | Description                                                           |
| ------ | ----------------------------- | ------ | --------------------------------------------------------------------- |
| POST   | `/payments/mpesa/stk`         | 👤     | Send an STK push (`phone`, whole-shilling `amount` 1–250,000)         |
| GET    | `/payments/mpesa/:id`         | 👤     | Status (cashiers: own only). May query Daraja if the callback is late |
| GET    | `/payments/mpesa/unclaimed`   | 🧑‍💼     | Successful payments not attached to any sale (latest 100)             |
| POST   | `/payments/mpesa/:id/resolve` | 🧑‍💼     | Record `REFUNDED` or `WRITTEN_OFF` with a note                        |
| POST   | `/payments/hooks/stk/:secret` | 🔓     | Daraja callback. Authenticated by the secret in the path              |

### Reports

Range parameters `from` / `to` are `YYYY-MM-DD`. Omitted `from` and `to` means today. Maximum span is 366 days.

| Method | Path                       | Access                | Description                                                                                                                               |
| ------ | -------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/reports/dashboard`       | 🧑‍💼                    | One call: today's KPIs, 7-day trend, top products, low stock, recent sales, inventory summary, alerts (unclaimed M-Pesa, eTIMS attention) |
| GET    | `/reports/overview`        | 🧑‍💼                    | Transactions, revenue, net sales, tax, average basket, items sold, gross profit, margin %, change vs the previous equal period, voids     |
| GET    | `/reports/trend`           | 🧑‍💼                    | Time series with empty buckets filled. `interval`: `hour` (≤7 days), `day`, `week`, `month`. Auto-selected if omitted                     |
| GET    | `/reports/top-products`    | 🧑‍💼                    | `by`: `revenue` (default), `quantity`, `profit`; `limit` ≤ 50                                                                             |
| GET    | `/reports/categories`      | 🧑‍💼                    | Sales by category (uses each product's current category)                                                                                  |
| GET    | `/reports/payment-methods` | 🧑‍💼                    | Totals by CASH / MPESA / CARD                                                                                                             |
| GET    | `/reports/tax`             | 🧑‍💼                    | VAT collected, net sales and gross, grouped by rate                                                                                       |
| GET    | `/reports/cashiers`        | 🧑‍💼                    | Per-cashier transactions, revenue, average basket                                                                                         |
| GET    | `/reports/shift`           | 👤 cashier or manager | End-of-shift summary for one day (`date`). Cashiers always get their own; managers may pass `cashierId`                                   |

Only `COMPLETED` sales are counted; voids are reported separately.

### Settings

| Method | Path              | Access | Description                                         |
| ------ | ----------------- | ------ | --------------------------------------------------- |
| GET    | `/settings/store` | 👤     | Store name, address, phone, tax PIN, receipt footer |
| PATCH  | `/settings/store` | 🛡️     | Update any of those fields                          |

### eTIMS

| Method     | Path                           | Access | Description                                                                                                           |
| ---------- | ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------- |
| GET        | `/etims/sales/:saleId`         | 👤     | Tax-invoice status for a sale (cashiers: own sales; error details hidden from cashiers)                               |
| POST       | `/etims/sales/:saleId/printed` | 👤     | Mark the accepted invoice as printed; later prints are labelled COPY                                                  |
| GET        | `/etims/summary`               | 🧑‍💼     | Counts by status, stuck count, needs-attention count, last accepted, unreviewed products                              |
| GET        | `/etims/invoices`              | 🧑‍💼     | List. Filters: `status` (incl. `ATTENTION`), `type`, `search`, `from`, `to`                                           |
| GET        | `/etims/invoices/:id`          | 🧑‍💼     | Detail with job state and full event history                                                                          |
| POST       | `/etims/invoices/:id/retry`    | 🧑‍💼     | Retry a REJECTED / FAILED / UNCERTAIN invoice. `rebuild: true` refreshes catalogue fields (not allowed for UNCERTAIN) |
| POST       | `/etims/retry-failed`          | 🧑‍💼     | Bulk-retry up to 200 FAILED invoices                                                                                  |
| POST       | `/etims/invoices/:id/resolve`  | 🧑‍💼     | Settle an UNCERTAIN invoice: `CONFIRM_FILED` (🛡️ only; enter KRA's official data) or `CONFIRM_NOT_FILED`              |
| GET        | `/etims/tax-review`            | 🧑‍💼     | Products whose VAT class has not been confirmed (`all=true` for every product)                                        |
| POST       | `/etims/tax-review/confirm`    | 🧑‍💼     | Confirm VAT classes for a list of `productIds`                                                                        |
| GET        | `/etims/tax-types`             | 🧑‍💼     | The five KRA tax classes and their rates                                                                              |
| PATCH      | `/etims/tax-types/:code`       | 🛡️     | Change a class's rate (audit-logged)                                                                                  |
| GET / POST | `/etims/dev/mock-mode`         | 🛡️     | Read / set mock behaviour. Dev only, mock provider only                                                               |

## Core flows in detail

### Pricing and VAT

Shelf prices are **VAT-inclusive**. VAT is extracted, not added:

```
lineTotal = round(price × qty)
vat       = round(lineTotal × rate / (100 + rate))
net       = lineTotal − vat
```

Rounding is half-up to 2 decimals. The rate comes from the product's tax class (`A`–`E`) in the `TaxType` table:

| Class | Name          | Default rate |
| ----- | ------------- | ------------ |
| A     | Exempt        | 0%           |
| B     | Standard rate | 16%          |
| C     | Zero-rated    | 0%           |
| D     | Non-VAT       | 0%           |
| E     | Reduced rate  | 8%           |

### Checkout

`POST /sales`

```json
{
  "clientRequestId": "7b0f2b0e-3c1a-4a58-9d59-3f6d1f0f0a11",
  "items": [
    { "productId": "clx...", "quantity": 3 },
    { "productId": "cly...", "quantity": 1 }
  ],
  "payments": [
    { "method": "MPESA", "amount": 200, "mpesaPaymentId": "clm..." },
    { "method": "CASH", "amount": 110, "tendered": 200 }
  ],
  "customerId": "optional",
  "customerPin": "A123456789Z",
  "customerName": "Acme Ltd"
}
```

What happens, all in **one database transaction**:

1. Duplicate lines are merged; products are loaded (must exist and be active).
2. Each line is priced and VAT is extracted.
3. Payments are validated:
   - **CASH:** `tendered` (defaults to `amount`) must cover `amount`; change is computed.
   - **MPESA with `mpesaPaymentId`:** the STK payment must be `SUCCESS`, unused, unresolved, for the **exact amount**, and (for cashiers) requested by the same cashier.
   - **MPESA without `mpesaPaymentId`:** rejected unless `MPESA_ALLOW_MANUAL_REFERENCE=true`.
   - **CARD (or manual M-Pesa):** a `reference` is required and must be unique per method.
   - Payment amounts must **add up exactly** to the sale total.
4. The sale, items and payments are created. The receipt number comes from a database sequence.
5. Each STK payment is claimed with a conditional update, so two requests cannot use the same payment.
6. Stock is deducted per line (sorted order, to avoid deadlocks). Any shortfall rolls everything back.
7. If eTIMS is enabled, a tax invoice and its job are created in the same transaction.

**Idempotency:** send a fresh `clientRequestId` (e.g. UUID) per checkout attempt and reuse it on retries. A repeat returns the original sale instead of creating a second one, including when two identical requests race.

`customerPin` must look like a KRA PIN (`A` or `P`, 9 digits, a letter).

### Voiding a sale

`POST /sales/:id/void` with `{ "reason": "..." }` (manager+).

In one transaction: the sale flips `COMPLETED → VOIDED` (only one request can win), the tax invoice is dealt with, and each line's quantity is returned to stock as a `RETURN` movement.

Tax-invoice handling:

| Invoice state                     | What happens                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| Not yet sent to KRA               | Cancelled; no invoice number is consumed                       |
| Accepted                          | A **credit note** is queued to reverse it                      |
| Being sent / rejected / uncertain | Void is refused with 409. Resolve it on the eTIMS screen first |

### M-Pesa STK push

```mermaid
sequenceDiagram
  participant T as Till
  participant A as API
  participant D as Daraja
  participant C as Customer
  T->>A: POST /payments/mpesa/stk
  A->>A: Save PENDING record
  A->>D: STK push
  D->>C: PIN prompt
  T->>A: GET /payments/mpesa/:id (poll)
  C->>D: Enter PIN
  D->>A: Callback (secret in URL)
  A->>A: SUCCESS + receipt code
  T->>A: POST /sales { mpesaPaymentId }
```

Key behaviours:

- **Phone numbers** are normalised (`0712…`, `+254712…`, `712…` → `254712…`). Safaricom prefixes `7` and `1` are accepted.
- **Double-click protection:** an identical pending request from the same cashier within 90 seconds is reused.
- **Record first:** the payment row is saved before the request is sent, so nothing is lost.
- **Callback checks:** wrong secret → 403; amount mismatch → ignored (stays pending); unknown checkout ID → logged. With `MPESA_VERIFY_CALLBACKS=true` a success callback is confirmed with a Daraja query first.
- **Self-healing:** polling asks Daraja directly if the callback is late (after 15 seconds, at most once per 10 seconds). A cron runs every minute for payments pending over 90 seconds.
- **Statuses:** `PENDING`, `SUCCESS`, `FAILED`, `CANCELLED` (customer cancelled), `TIMEOUT` (no response). After 5 minutes of silence a payment is marked `TIMEOUT`.
- **Money in hand wins:** a late confirmed success can replace an earlier FAILED / TIMEOUT / CANCELLED label; a failure never overwrites a success.
- **Reconciliation:** `GET /payments/mpesa/unclaimed` lists money that arrived without a sale; a manager closes each with `REFUNDED` or `WRITTEN_OFF` plus a note.
- **Whole shillings only.** If the bill has cents, take those in cash as a split payment.

### eTIMS tax invoices

Enabled when `ETIMS_PROVIDER` is `mock` (or, in future, `oscu`).

```mermaid
stateDiagram-v2
  [*] --> PENDING: sale created
  PENDING --> ACCEPTED: KRA accepts
  PENDING --> REJECTED: KRA refuses / local validation fails
  PENDING --> PENDING: temporary failure, retry with backoff
  PENDING --> UNCERTAIN: timeout / lost reply
  PENDING --> FAILED: attempts exhausted
  PENDING --> CANCELLED: sale voided before sending
  UNCERTAIN --> ACCEPTED: reconcile / manual confirm
  UNCERTAIN --> PENDING: manual "not filed"
  REJECTED --> PENDING: manager retry
  FAILED --> PENDING: manager retry
```

How it works:

1. **Queue:** the invoice and a job are created inside the sale transaction.
2. **Send:** a worker (every 5 seconds) claims due jobs with `FOR UPDATE SKIP LOCKED` and a 2-minute lease, oldest first. Safe to run on several instances.
3. **Number:** the KRA invoice number is allocated from `EtimsSequence` under a row lock at _first transmission_, not at sale time, so cancelled invoices never burn a number.
4. **Validate:** the payload is checked locally (PIN format, amounts reconcile, tax buckets, etc.) before leaving.
5. **Mark as sent:** `sentAt` is written before the request. If the outcome is unknown afterwards, the next attempt **reconciles** instead of resubmitting, avoiding duplicates.
6. **Outcomes:** `ACCEPTED`, `REJECTED` (needs a human), `RETRYABLE` (definitely not processed), `UNCERTAIN` (may have been processed).
7. **Backoff:** 30s, 1m, 2m, 4m… capped at 1 hour, with jitter.
8. **Alerts:** one alert per invoice per reason (rejected, repeated failures, gave up, stuck). Logged, and posted to `ETIMS_ALERT_WEBHOOK_URL` if set.
9. **Audit:** every transition is stored as an `EtimsEvent`.

What cashiers and receipts show (`display` status):

`NOT_REQUIRED`, `PENDING`, `ACCEPTED`, `MOCK_ACCEPTED`, `FAILED`, `CANCELLED`. Mock filings can never read as real ones, and KRA identifiers (invoice number, signature, QR) appear on a receipt only once the invoice is accepted.

**Tax-class governance:** new products are `taxConfirmed: false` until someone reviews them via `/etims/tax-review`. `unreviewedProducts` appears in the eTIMS summary. Rate changes and class changes go to the `AuditLog`.

### Receipts

`GET /sales/:id/receipt` returns store details, receipt number, date, status, cashier, customer, items, a **tax breakdown by class** (net, VAT, gross), totals, payments, change due, and the eTIMS block. `etims.copy` is the number of earlier official prints; above 0 the print should be labelled **COPY**.

## Data model

Main tables (see `prisma/schema.prisma`):

| Model                                                   | Purpose                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `User`                                                  | Staff accounts, role, active flag, `mustChangePassword`                                              |
| `Category`, `Product`                                   | Catalogue. Product holds price, cost, stock, reorder level, tax class and eTIMS item fields          |
| `Sale`, `SaleItem`, `Payment`                           | A sale, its line snapshots, and its payments (cash tendered and change included)                     |
| `StockMovement`                                         | Signed stock ledger (`PURCHASE`, `SALE`, `ADJUSTMENT`, `RETURN`). Movements always sum to `stockQty` |
| `MpesaPayment`                                          | STK requests and their outcomes; links to a sale once claimed; manual resolution fields              |
| `StoreSettings`                                         | Single row (`id = "store"`) for receipt header/footer and tax PIN                                    |
| `TaxType`                                               | The five KRA classes and their editable rates                                                        |
| `TaxInvoice`, `EtimsJob`, `EtimsEvent`, `EtimsSequence` | Invoice record, outbox job, audit events, gap-free numbering                                         |
| `AuditLog`                                              | Who changed what for tax-relevant data                                                               |
| `Customer`                                              | Customer record (no API endpoints yet)                                                               |

Migrations live in `prisma/migrations`. Apply with `npx prisma migrate deploy`; create new ones in development with `npx prisma migrate dev`.

## Background jobs

| Job                   | Schedule     | Purpose                                                     |
| --------------------- | ------------ | ----------------------------------------------------------- |
| eTIMS worker          | every 5 s    | Send due tax invoices, retry, reconcile                     |
| eTIMS stuck check     | every 5 min  | Alert on invoices pending longer than `ETIMS_STUCK_MINUTES` |
| M-Pesa stale resolver | every minute | Query Daraja for abandoned pending payments (20 per run)    |

## Testing

```bash
npm test             # unit tests (pricing, phone normalisation, …)
npm run test:cov     # with coverage
npm run lint         # oxlint, type-aware
npm run format       # prettier
```

### End-to-end tests

The e2e suite uses a real PostgreSQL database and **wipes every table** before each run. The helpers refuse to run unless `DATABASE_URL` contains `_test`.

1. Create a database, e.g. `pos_test`.
2. Put a `.env.test` in the project root:

   ```dotenv
   DATABASE_URL="postgresql://pos:pos@localhost:5438/pos_test?schema=public"
   JWT_SECRET="test-secret-test-secret-test-secret"
   THROTTLE_DISABLED=true
   ETIMS_PROVIDER=mock
   MPESA_CONSUMER_KEY=x
   MPESA_CONSUMER_SECRET=x
   MPESA_SHORTCODE=174379
   MPESA_PASSKEY=x
   MPESA_CALLBACK_BASE_URL=https://example.test
   MPESA_CALLBACK_SECRET=test-callback-secret-1234
   ```

   (Adjust to what the specs need; `THROTTLE_DISABLED=true` is important because login is limited to 5 per minute.)

3. Run:

   ```bash
   npm run test:e2e
   ```

Coverage includes: auth and role boundaries, forced password change, checkout (VAT, oversell, concurrency, idempotency), void, stock-ledger integrity, M-Pesa callbacks and late/pending handling, reports, store settings, and the eTIMS lifecycle (outage retry, lost reply, duplicate refusal, void and credit note).

## Deployment checklist

- [ ] `NODE_ENV=production`
- [ ] Strong `JWT_SECRET` (32+ random characters)
- [ ] `FRONTEND_ORIGIN` set to your real frontend URL(s)
- [ ] `TRUST_PROXY=true` if behind nginx or a load balancer
- [ ] HTTPS in front of the API (required for the M-Pesa callback)
- [ ] `npx prisma migrate deploy` run before starting
- [ ] Seed with `SEED_ADMIN_PASSWORD` set, then change that password
- [ ] M-Pesa: production credentials, `MPESA_ENV=production`, long `MPESA_CALLBACK_SECRET`, consider `MPESA_VERIFY_CALLBACKS=true`
- [ ] Do not expose Postgres publicly; change the default `pos/pos` credentials
- [ ] Back up the database (it is the system of record for stock, sales and tax invoices)
- [ ] Leave `ENABLE_DOCS` unset unless you want public Swagger
- [ ] `ETIMS_PROVIDER` is **not** `mock` for real trading (and `oscu` is not yet implemented)

## Known limitations

These are known gaps, not bugs you introduced by configuring something wrong:

- **No live KRA integration.** `ETIMS_PROVIDER=oscu` throws at startup. Only the mock provider works, so no invoice is actually filed.
- **`ETIMS_TIN` has a placeholder fallback.** If unset, the mock uses a made-up PIN. Always set it, and treat a missing value as a startup error once the live provider exists.
- **Environment validation is not wired in.** `src/config/env.validation.ts` exists but is not passed to `ConfigModule`, so its production checks do not run yet.
- **M-Pesa uncertainty on send.** If the STK request times out after Daraja received it, the payment is marked failed locally and a later callback may be unmatched.
- **Voids do not refund M-Pesa.** A voided sale's M-Pesa payment stays attached to it and does not appear in the unclaimed list.
- **Rate limits are per IP.** Several tills behind one router share one limit.
- **Date filters on list endpoints** (`from`/`to` on sales, movements, invoices) use literal timestamps, unlike reports which use business days.
- **VAT report groups by rate**, so Exempt, Zero-rated and Non-VAT (all 0%) appear merged.
- **Tokens are not revocable** before expiry (default 12 hours), apart from deactivating the user.
- **No customers API, discounts, partial returns, till/cash-drawer sessions, suppliers or purchase orders.** The related schema fields exist but are unused.

## Project structure

```
prisma/
  schema.prisma          Data model
  migrations/            SQL migrations
  seed.ts                Demo data (admin, staff, catalogue, optional sales)
  seed-initial.ts        Single-admin seed
src/
  main.ts                Bootstrap: Helmet, CORS, Swagger, shutdown hooks
  app.module.ts          Module wiring and global guards
  app.setup.ts           Global prefix, validation pipe, exception filter
  auth/                  Login, JWT strategy, guards, decorators
  users/                 User management, password change/reset
  categories/            Category CRUD
  products/              Catalogue, scanner lookup, tax resolution
  inventory/             Restock, adjust, count, ledger, summary
  sales/                 Checkout, pricing, receipts, voids
  mpesa/                 Daraja client, STK service, callback, reconciliation
  reports/               Dashboard and report queries (raw SQL, timezone-aware)
  settings/              Store settings
  etims/                 Service, worker, alerts, payload builder, mock provider
  audit/                 Audit-log helper
  common/                Prisma exception filter
  config/                Environment validation
  health/                Health endpoint
test/
  *.e2e-spec.ts          End-to-end suites
  helpers.ts             App bootstrap, DB reset, seed helpers
certificates/            Safaricom sandbox certificate (not used by the code)
docker-compose.yml       Local PostgreSQL
```

## Scripts

| Script                                 | Description                            |
| -------------------------------------- | -------------------------------------- |
| `npm run start:dev`                    | Run with file watching                 |
| `npm run start` / `start:debug`        | Run once / with debugger               |
| `npm run build`                        | Compile to `dist/`                     |
| `npm run start:prod`                   | Run compiled build                     |
| `npm test` / `test:watch` / `test:cov` | Unit tests                             |
| `npm run test:e2e`                     | Migrate the test DB and run e2e suites |
| `npm run lint`                         | oxlint (type-aware)                    |
| `npm run format`                       | Prettier                               |
