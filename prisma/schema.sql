-- Full schema — compatible with Supabase transaction pooler (no dollar-quoting)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ENUMS (simple IF NOT EXISTS via cast trick)
CREATE TYPE "TransactionType" AS ENUM ('OPENING','STOCK_IN','STOCK_OUT','MARKETPLACE_DISPATCH','RETURN','CANCELLATION','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT');
CREATE TYPE "ImeiStatus" AS ENUM ('IN_STOCK','SOLD','RETURNED','OPEN_BOX','DAMAGED','CANCELLED','BLOCKED');
CREATE TYPE "Marketplace" AS ENUM ('AMAZON','FLIPKART','JIOMART','PRIME','OTHER');
CREATE TYPE "MarketplaceOrderStatus" AS ENUM ('PENDING','CONFIRMED','DISPATCHED','DELIVERED','CANCELLED','RETURNED');
CREATE TYPE "OpenBoxGrade" AS ENUM ('A','B','C','D');
CREATE TYPE "ReportType" AS ENUM ('STOCK_IN','STOCK_OUT','VENDOR','MARKETPLACE','IMEI','PROFIT','OPEN_BOX','INVENTORY_VALUATION','DEAD_STOCK','LOW_STOCK');
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED','PROCESSING','COMPLETED','FAILED');
CREATE TYPE "ImportType" AS ENUM ('STOCK_IN','STOCK_OUT','PRODUCTS','IMEI','VENDORS');
CREATE TYPE "ImportStatus" AS ENUM ('PENDING','VALIDATING','PARTIAL','COMPLETED','REJECTED');
CREATE TYPE "AuditAction" AS ENUM ('CREATE','UPDATE','DELETE','RESTORE','LOGIN','EXPORT','IMPORT');
CREATE TYPE "NotificationType" AS ENUM ('LOW_STOCK','DEAD_STOCK','IMPORT_DONE','EXPORT_DONE','SYSTEM');

-- TABLES
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastLoginAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- These two tables hold every role assignment and every granted permission.
-- They were previously DROPped and recreated on each deploy, which ran on every
-- Render restart — so an admin's grants and staff role assignments vanished a
-- few hours after being set. Create-if-absent only: this file runs constantly
-- and must never destroy live data.
CREATE TABLE IF NOT EXISTS "_UserRoles" (
  "A" TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  "B" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE("A","B")
);

CREATE TABLE IF NOT EXISTS "_RolePermissions" (
  "A" TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  "B" TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  UNIQUE("A","B")
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL REFERENCES users(id),
  "tokenHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL REFERENCES users(id),
  "tokenHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "usedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_audits (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_categories (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  "parentId" TEXT REFERENCES product_categories(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  "contactPerson" TEXT,
  phone TEXT,
  email TEXT,
  gstin TEXT,
  address TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  address TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ean TEXT NOT NULL,
  sku TEXT NOT NULL,
  model TEXT NOT NULL,
  brand TEXT NOT NULL,
  "categoryId" TEXT REFERENCES product_categories(id),
  description TEXT,
  "costPrice" NUMERIC(12,2) NOT NULL,
  "sellingPrice" NUMERIC(12,2) NOT NULL,
  "gstRate" NUMERIC(5,2) NOT NULL DEFAULT 0,
  "hsnCode" TEXT,
  "vendorId" TEXT REFERENCES vendors(id),
  "imeiRequired" BOOLEAN NOT NULL DEFAULT false,
  "serialRequired" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS stock_locations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "warehouseId" TEXT NOT NULL REFERENCES warehouses(id),
  "binCode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT,
  UNIQUE("warehouseId","binCode")
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "productId" TEXT NOT NULL REFERENCES products(id),
  "warehouseId" TEXT NOT NULL REFERENCES warehouses(id),
  type "TransactionType" NOT NULL,
  quantity INTEGER NOT NULL,
  "unitCost" NUMERIC(12,2),
  "vendorId" TEXT REFERENCES vendors(id),
  "referenceType" TEXT,
  "referenceId" TEXT,
  remarks TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT
);

CREATE TABLE IF NOT EXISTS stock_levels (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "productId" TEXT NOT NULL REFERENCES products(id),
  "warehouseId" TEXT NOT NULL REFERENCES warehouses(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("productId","warehouseId")
);

CREATE TABLE IF NOT EXISTS imei_inventory (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "productId" TEXT NOT NULL REFERENCES products(id),
  "warehouseId" TEXT NOT NULL REFERENCES warehouses(id),
  imei1 TEXT NOT NULL,
  imei2 TEXT,
  status "ImeiStatus" NOT NULL DEFAULT 'IN_STOCK',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS open_box_inventory (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "productId" TEXT NOT NULL REFERENCES products(id),
  imei TEXT,
  grade "OpenBoxGrade" NOT NULL,
  "testingNotes" TEXT,
  remarks TEXT,
  images TEXT[] DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  marketplace "Marketplace" NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "shipmentNumber" TEXT,
  status "MarketplaceOrderStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT,
  UNIQUE(marketplace,"orderNumber")
);

CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "orderId" TEXT NOT NULL REFERENCES marketplace_orders(id),
  sku TEXT NOT NULL,
  ean TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  imei TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "orderId" TEXT REFERENCES marketplace_orders(id),
  "productId" TEXT,
  imei TEXT,
  quantity INTEGER NOT NULL,
  reason TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS cancellations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "orderId" TEXT NOT NULL UNIQUE REFERENCES marketplace_orders(id),
  reason TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT,
  action "AuditAction" NOT NULL,
  "entityName" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "oldValue" JSONB,
  "newValue" JSONB,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_exports (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type "ReportType" NOT NULL,
  status "ReportStatus" NOT NULL DEFAULT 'QUEUED',
  params JSONB,
  "filePath" TEXT,
  "requestedBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type "ImportType" NOT NULL,
  status "ImportStatus" NOT NULL DEFAULT 'PENDING',
  "fileName" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "successRows" INTEGER NOT NULL DEFAULT 0,
  "failedRows" INTEGER NOT NULL DEFAULT 0,
  errors JSONB,
  "importedBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT,
  type "NotificationType" NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Fix tables created in earlier runs without timestamp defaults
ALTER TABLE permissions ALTER COLUMN "updatedAt" SET DEFAULT now();
ALTER TABLE permissions ALTER COLUMN "createdAt" SET DEFAULT now();
ALTER TABLE roles ALTER COLUMN "updatedAt" SET DEFAULT now();
ALTER TABLE roles ALTER COLUMN "createdAt" SET DEFAULT now();
ALTER TABLE users ALTER COLUMN "updatedAt" SET DEFAULT now();
ALTER TABLE users ALTER COLUMN "createdAt" SET DEFAULT now();

-- INDEXES
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);
CREATE INDEX IF NOT EXISTS ix_users_deleted ON users("isDeleted");
CREATE INDEX IF NOT EXISTS ix_products_ean ON products(ean);
CREATE INDEX IF NOT EXISTS ix_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS ix_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS ix_products_deleted ON products("isDeleted");
CREATE INDEX IF NOT EXISTS ix_inv_txn_product_wh ON inventory_transactions("productId","warehouseId");
CREATE INDEX IF NOT EXISTS ix_inv_txn_type ON inventory_transactions(type);
CREATE INDEX IF NOT EXISTS ix_inv_txn_created ON inventory_transactions("createdAt");
CREATE INDEX IF NOT EXISTS ix_imei_product ON imei_inventory("productId");
CREATE INDEX IF NOT EXISTS ix_imei_status ON imei_inventory(status);
CREATE INDEX IF NOT EXISTS ix_imei_imei1 ON imei_inventory(imei1);
CREATE INDEX IF NOT EXISTS ix_imei_pwh_status ON imei_inventory("productId","warehouseId",status);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs("entityName","entityId");
CREATE INDEX IF NOT EXISTS ix_audit_user ON audit_logs("userId");
CREATE INDEX IF NOT EXISTS ix_login_email ON login_audits(email);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications("userId","isRead");

-- UNIQUE PARTIAL INDEXES (soft-delete safe)
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email) WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_ean ON products(ean) WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku ON products(sku) WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_imei_imei1 ON imei_inventory(imei1) WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_imei_imei2 ON imei_inventory(imei2) WHERE "isDeleted" = false AND imei2 IS NOT NULL;

-- CONSTRAINTS
ALTER TABLE stock_levels DROP CONSTRAINT IF EXISTS chk_stock_nonneg;
ALTER TABLE stock_levels ADD CONSTRAINT chk_stock_nonneg CHECK (quantity >= 0);

-- ProductStatus enum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED');

-- Brand master table
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ,
  "deletedBy" TEXT
);

-- Product attributes (dynamic key-value)
CREATE TABLE IF NOT EXISTS product_attributes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "productId" TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("productId", key)
);

-- Saved views
CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  columns JSONB NOT NULL DEFAULT '[]',
  "sortBy" TEXT,
  "sortDir" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add new columns to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS "brandId" TEXT REFERENCES brands(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS status "ProductStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS "minStock" INTEGER NOT NULL DEFAULT 0;

-- New indexes
CREATE INDEX IF NOT EXISTS ix_products_brandid ON products("brandId");
CREATE INDEX IF NOT EXISTS ix_products_status ON products(status);
CREATE INDEX IF NOT EXISTS ix_brands_name ON brands(name);
CREATE INDEX IF NOT EXISTS ix_product_attrs ON product_attributes("productId");


-- ════════════════════════════════════════════════════════════════
-- ADD MISSING COLUMNS (safe to re-run — IF NOT EXISTS prevents errors)
-- ════════════════════════════════════════════════════════════════

-- Vendor: normalizedName (dedup key), state, notes
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS "normalizedName" TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS notes TEXT;

-- IMEI Inventory: type tracking, swiped flag, supplier link
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "imeiType" TEXT NOT NULL DEFAULT 'NIL';
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS swiped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "supplierId" TEXT;
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "purchaseDate" TIMESTAMPTZ;
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "invoiceNo" TEXT;

-- inventory_transactions: soft-delete columns (for dashboard delete)
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;

-- Backfill: set normalizedName for existing vendors where it is null
UPDATE vendors 
SET "normalizedName" = lower(regexp_replace(trim(name), '\s+', '', 'g'))
WHERE "normalizedName" IS NULL;

-- imei_inventory: swipedAt timestamp for tracking when IMEI was swiped
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "swipedAt" TIMESTAMPTZ;

-- imei_inventory: stockInTxnId — permanent link to the InventoryTransaction that created this IMEI
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "stockInTxnId" TEXT REFERENCES inventory_transactions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS imei_inventory_stock_in_txn_id ON imei_inventory("stockInTxnId");

-- brands: add imeiRequired and srnoRequired columns
ALTER TABLE brands ADD COLUMN IF NOT EXISTS "imeiRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS "srnoRequired" BOOLEAN NOT NULL DEFAULT false;

-- Pre-populate brand IMEI/SrNo requirements from brand configuration
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='Amazon';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Apple';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='Bang & Olufsen';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Google';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='Harman Kardon';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Honor';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='Infinity';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Infinix';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='JBL';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Lenovo';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='LG';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='Marshall';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Micromax';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Motorola';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Nokia';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Nothing';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='OnePlus';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='OPPO';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Poco';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Realme';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Samsung';
UPDATE brands SET "imeiRequired"=false, "srnoRequired"=true WHERE name='Sennheiser';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Tecno';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=false WHERE name='Videocon';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Vivo';
UPDATE brands SET "imeiRequired"=true, "srnoRequired"=true WHERE name='Xiaomi';

-- imei_inventory: activated + activatedAt (unit demo'd/activated by customer)
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "activated"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMPTZ;
