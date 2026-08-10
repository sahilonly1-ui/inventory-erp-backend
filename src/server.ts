import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { logger } from './config/logger';
import { initSocket } from './realtime/socket';

// ── Auto-migrate missing columns on every startup ────────────────────────────
// These ALTER TABLE statements are safe to re-run (IF NOT EXISTS)
// Guarantees the Supabase DB schema matches the Prisma model regardless of
// which npm start script Render uses.
async function ensureSchema() {
  const alters = [
    // Vendor: state, normalizedName, notes
    `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS "normalizedName" TEXT`,
    `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS notes TEXT`,
    // IMEI Inventory: type, swiped flag, supplier link
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "imeiType" TEXT NOT NULL DEFAULT 'NIL'`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS swiped BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "supplierId" TEXT`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "purchaseDate" TIMESTAMPTZ`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "invoiceNo" TEXT`,
    // InventoryTransaction: soft-delete support
    `ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ`,
    `ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedBy" TEXT`,
    // Backfill normalizedName for existing vendors
    `UPDATE vendors SET "normalizedName" = lower(regexp_replace(trim(name), '\\s+', '', 'g')) WHERE "normalizedName" IS NULL`,
  ];
  let ok = 0;
  for (const sql of alters) {
    try { await prisma.$executeRawUnsafe(sql); ok++; } catch {}
  }
  logger.info(`Schema auto-migration: ${ok}/${alters.length} statements applied`);
}

async function bootstrap() {
  // Run schema migrations before starting the server
  await ensureSchema();

  const app = createApp();
  const server = http.createServer(app);

  server.listen(env.PORT, () => {
    logger.info(`ERP backend listening on :${env.PORT} [${env.NODE_ENV}]`);
  });

  initSocket(server); // live stock updates over websocket

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Closed HTTP server and DB connections');
      process.exit(0);
    });
    // Force-exit if graceful close hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });
}

void bootstrap();
