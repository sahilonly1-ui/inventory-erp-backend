# Inventory ERP + CRM — Backend

Production-grade inventory ERP for mobile-phone retail/wholesale/marketplace.
Node.js · Express · PostgreSQL · Prisma · JWT · Argon2 · ExcelJS · Socket.IO · Zod · Pino.

## What it does
- **EAN master + products**, categories, vendors, multi-warehouse master data.
- **Transaction-driven inventory engine** — `InventoryTransaction` is the source of
  truth, `StockLevel` is a row-locked cache; reads come from the cache, writes
  update both atomically. **Stock can never go negative** (app guard + DB CHECK).
- **IMEI engine** — every unit tracked; status drives availability; sells are
  row-locked so an IMEI can't be sold twice. IMEI + ledger + StockLevel are kept
  **three-way reconciled** in the same transaction.
- **Warehouse transfers**, **adjustments**, **vendor stock + aging**.
- **Marketplace** orders (Amazon/Flipkart/JioMart/Prime): import, dispatch,
  cancellation, returns — all as ledger movements (no double counting).
- **Excel import** (products / vendors / stock / IMEI) with auto column mapping,
  per-row validation, and import logs.
- **Excel export** reports: Stock In/Out, Vendor, Marketplace, IMEI, Profit,
  Open Box, Inventory Valuation, Dead Stock, Low Stock.
- **Realtime** stock updates over Socket.IO.
- **RBAC** (roles + permissions), refresh-token rotation with reuse detection,
  **soft delete + restore** everywhere, full **audit trail**.

## Quick start (local)
```bash
cp .env.example .env                 # set secrets: openssl rand -base64 48
npm install
npx prisma migrate dev --name init   # create tables
npm run db:constraints               # partial unique indexes + non-negative CHECK
npm run seed                         # permissions, ADMIN/STAFF roles, bootstrap admin
npm run dev                          # http://localhost:8080/api/v1/health
```

## Deploy (Railway)
Add a PostgreSQL plugin (sets `DATABASE_URL`) and the JWT secrets, then deploy.
`railway.json` runs: `migrate deploy → apply-constraints → start`.

## Auth
1. `POST /api/v1/auth/login` → `{ accessToken, refreshToken }`
2. Send `Authorization: Bearer <accessToken>` on every call.
3. `POST /api/v1/auth/refresh` rotates tokens. Socket.IO: pass the access token
   as `auth.token` in the handshake.

## Endpoints (prefix `/api/v1`)
- **auth**: login, refresh, logout, forgot-password, reset-password, change-password, me
- **users**: CRUD + `/:id/roles`, `/:id/restore`
- **products**: CRUD + `/categories`
- **warehouses**: CRUD
- **vendors**: CRUD + `/:id/stock`, `/:id/aging`
- **inventory**: `stock-in`, `stock-out`, `adjust`, `transfer`, `reconcile`,
  `GET stock`, `GET ledger`, `GET lookup?ean=`
- **imei**: `receive`, `dispatch`, `PATCH /:imei/status`, `GET /`, `GET /:imei`
- **marketplace**: `orders` (create/list), `orders/:id`,
  `orders/:id/{dispatch,cancel,return}`
- **reports**: `POST /reports/:type` → streams `.xlsx`
  (`STOCK_IN|STOCK_OUT|VENDOR|MARKETPLACE|IMEI|PROFIT|OPEN_BOX|INVENTORY_VALUATION|DEAD_STOCK|LOW_STOCK`)
- **imports**: `POST /imports/:type` (multipart `file`)
  (`PRODUCTS|VENDORS|STOCK_IN|STOCK_OUT|IMEI`)

## Notes
- Default roles: **ADMIN** (wildcard `*`) and **STAFF** (read-only baseline).
- Returned IMEI units land as `RETURNED` (not auto-resellable); restock via a
  status change back to `IN_STOCK`.
- Forgot-password returns the token only in non-production; wire an email
  transport for production.
