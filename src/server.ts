import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { logger } from './config/logger';
import { initSocket } from './realtime/socket';
import { startScheduler } from './scheduler';

// ── Auto-migrate the ENTIRE schema.sql on every startup ──────────────────────
// schema.sql has grown into a running log of every ALTER TABLE ever added
// (stockInTxnId, swiped, swipedAt, activated, brands.imeiRequired, etc).
// Previously ensureSchema() only replayed a hand-picked subset of these, so
// any code path touching a column NOT in that subset kept 500-ing — a fresh
// recurring bug every time a different feature was touched. Fix: execute the
// FULL file (same approach as prisma/apply-schema.mjs), so every past and
// future ALTER TABLE in schema.sql is guaranteed applied, not just the ones
// we remembered to list by hand. Uses a direct pg client (NOT Prisma's
// pooler) because ALTER TABLE / CREATE TYPE need a persistent session
// connection, not a transaction-mode pooler connection.
export async function ensureSchema() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg') as typeof import('pg');

  const PROJECT = 'xukbgkwagjtzxoobcyuk';

  const dbUrl = process.env.DATABASE_URL || process.env.DIRECT_URL ||
    `postgresql://postgres:Harbans_1073@db.${PROJECT}.supabase.co:5432/postgres`;

  const parsed = (() => {
    try {
      const u = new URL(dbUrl);
      return { host: u.hostname, port: parseInt(u.port||'5432'), user: u.username, password: u.password, database: u.pathname.slice(1) };
    } catch { return null; }
  })();

  const configs = [
    ...(parsed ? [{ ...parsed, ssl:{rejectUnauthorized:false} }] : []),
    { host:`db.${PROJECT}.supabase.co`, port:5432, user:'postgres', password:'Harbans_1073', database:'postgres', ssl:{rejectUnauthorized:false} },
    { host:'aws-1-ap-northeast-1.pooler.supabase.com', port:5432, user:`postgres.${PROJECT}`, password:'Harbans_1073', database:'postgres', ssl:{rejectUnauthorized:false} },
    { host:'aws-1-ap-northeast-1.pooler.supabase.com', port:6543, user:`postgres.${PROJECT}`, password:'Harbans_1073', database:'postgres', ssl:{rejectUnauthorized:false} },
  ];

  let client: InstanceType<typeof Client> | null = null;
  for (const cfg of configs) {
    const c = new Client(cfg);
    try { await c.connect(); client = c; logger.info(`Schema migration: connected via ${cfg.host}:${cfg.port}`); break; }
    catch (e) { try { await c.end(); } catch {} }
  }

  if (!client) { logger.warn('Schema migration: could not connect — skipping'); return; }

  // Find schema.sql regardless of ts-node vs compiled dist, and regardless
  // of the process's working directory.
  const candidates = [
    path.join(__dirname, '..', 'prisma', 'schema.sql'),
    path.join(__dirname, '..', '..', 'prisma', 'schema.sql'),
    path.join(process.cwd(), 'prisma', 'schema.sql'),
  ];
  const schemaPath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

  if (!schemaPath) {
    logger.warn({ candidates }, 'Schema migration: schema.sql not found — skipping');
    await client.end();
    return;
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = sql.split(';')
    .map((s) => s.replace(/^(\s*--[^\n]*\n)+/gm, '').trim())
    .filter((s) => {
      if (s.length <= 5 || s.startsWith('--')) return false;
      // CRITICAL: skip DROP statements — schema.sql has DROP TABLE IF EXISTS for
      // "_UserRoles" and "_RolePermissions" which would destroy all role/permission
      // assignments on every server restart, locking everyone out of every page.
      if (s.trimStart().toUpperCase().startsWith('DROP ')) return false;
      return true;
    });

  let ok = 0, skip = 0, err = 0;
  for (const stmt of statements) {
    try { await client.query(stmt); ok++; }
    catch (e: any) {
      if (e.message?.includes('already exists') || e.message?.includes('duplicate')) skip++;
      else { err++; logger.warn({ msg: e.message?.slice(0, 160) }, 'Schema migration warn'); }
    }
  }
  await client.end();
  logger.info(`Schema auto-migration (${schemaPath}): ${statements.length} statements — ${ok} applied, ${skip} skipped, ${err} errors`);
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
  startScheduler();   // nightly stock-in backup email

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
