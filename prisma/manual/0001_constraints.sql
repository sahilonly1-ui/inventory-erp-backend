-- Run once after `prisma migrate dev` (or append into the generated migration).
-- Prisma's DSL cannot express partial unique indexes or CHECK constraints.
-- Note: Prisma keeps camelCase column names, hence the quoted identifiers.

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email   ON users(email)            WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_ean  ON products(ean)           WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku  ON products(sku)           WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_imei_imei1    ON imei_inventory(imei1)   WHERE "isDeleted" = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_imei_imei2    ON imei_inventory(imei2)   WHERE "isDeleted" = false AND imei2 IS NOT NULL;

-- Hard floor on stock — the engine never lets it trigger, but it is the last line of defence.
ALTER TABLE stock_levels DROP CONSTRAINT IF EXISTS chk_stock_nonneg;
ALTER TABLE stock_levels ADD  CONSTRAINT chk_stock_nonneg CHECK (quantity >= 0);

-- Speeds up IN_STOCK counts used by reconciliation.
CREATE INDEX IF NOT EXISTS ix_imei_pwh_status ON imei_inventory("productId","warehouseId","status");
