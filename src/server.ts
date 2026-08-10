import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { logger } from './config/logger';
import { initSocket } from './realtime/socket';

// ── Auto-migrate missing columns on every startup ────────────────────────────
// Uses direct pg client (NOT Prisma pooler) because ALTER TABLE requires a
// persistent session connection, not a transaction-mode pooler connection.
async function ensureSchema() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg') as typeof import('pg');

  const PROJECT = 'xukbgkwagjtzxoobcyuk';
  const PASSWORD = 'Harbans1073!';

  // Try multiple Supabase connection endpoints
  const configs = [
    { host:'aws-1-ap-northeast-1.pooler.supabase.com', port:5432, user:`postgres.${PROJECT}`, password:PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} },
    { host:'aws-1-ap-northeast-1.pooler.supabase.com', port:6543, user:`postgres.${PROJECT}`, password:PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} },
    { host:`db.${PROJECT}.supabase.co`, port:5432, user:'postgres', password:PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} },
  ];

  let client: InstanceType<typeof Client> | null = null;
  for (const cfg of configs) {
    const c = new Client(cfg);
    try { await c.connect(); client = c; logger.info(`Schema migration: connected via ${cfg.host}:${cfg.port}`); break; }
    catch (e) { try { await c.end(); } catch {} }
  }

  if (!client) { logger.warn('Schema migration: could not connect — skipping'); return; }

  const alters = [
    // Vendor: state, normalizedName, notes
    `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS "normalizedName" TEXT`,
    `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS notes TEXT`,
    // IMEI Inventory: type, swiped, supplier
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "imeiType" TEXT NOT NULL DEFAULT 'NIL'`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS swiped BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "supplierId" TEXT`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "purchaseDate" TIMESTAMPTZ`,
    `ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "invoiceNo" TEXT`,
    // InventoryTransaction: soft-delete
    `ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ`,
    `ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedBy" TEXT`,
    // Backfill normalizedName for existing vendors
    `UPDATE vendors SET "normalizedName" = lower(regexp_replace(trim(name), '\s+', '', 'g')) WHERE "normalizedName" IS NULL`,
  ];

  let ok = 0, skip = 0;
  for (const sql of alters) {
    try { await client.query(sql); ok++; }
    catch (e: any) {
      if (e.message?.includes('already exists') || e.message?.includes('duplicate')) skip++;
      else logger.warn({ msg: e.message?.slice(0, 120) }, 'Schema migration warn');
    }
  }
  await client.end();
  logger.info(`Schema auto-migration: ${ok} applied, ${skip} skipped`);
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
