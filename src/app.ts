import express, { Application } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import cors from 'cors';
import { env } from './config/env';
import { globalLimiter } from './middlewares/rateLimiter';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import apiRoutes from './routes';
import { logger } from './config/logger';

export function createApp(): Application {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway sits behind a proxy; needed for req.ip + rate limiting.

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(globalLimiter);

  app.use('/api/v1', apiRoutes);

  // ── One-time DB setup endpoint (public, idempotent) ────────────────────────
  // Visit https://inventory-erp-backend-iplr.onrender.com/db-setup to apply
  // any missing columns to the Supabase database.
  app.get('/db-setup', async (_req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg') as typeof import('pg');
    const PROJECT = 'xukbgkwagjtzxoobcyuk';
    const PASSWORD = 'Harbans1073!';
    const configs = [
      { host:'aws-1-ap-northeast-1.pooler.supabase.com', port:5432, user:`postgres.${PROJECT}`, password:PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} },
      { host:`db.${PROJECT}.supabase.co`, port:5432, user:'postgres', password:PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} },
      { host:'aws-1-ap-northeast-1.pooler.supabase.com', port:6543, user:`postgres.${PROJECT}`, password:PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} },
    ];
    let client: InstanceType<typeof Client> | null = null;
    let connLabel = '';
    for (const cfg of configs) {
      const c = new Client(cfg);
      try { await c.connect(); client = c; connLabel = `${cfg.host}:${cfg.port}`; break; }
      catch (e: any) { try { await c.end(); } catch {} }
    }
    if (!client) { return res.json({ ok: false, error: 'Could not connect to database' }); }
    const alters = [
      [`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS "normalizedName" TEXT`, 'vendor.normalizedName'],
      [`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state TEXT`, 'vendor.state'],
      [`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS notes TEXT`, 'vendor.notes'],
      [`ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "imeiType" TEXT NOT NULL DEFAULT 'NIL'`, 'imei.imeiType'],
      [`ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS swiped BOOLEAN NOT NULL DEFAULT false`, 'imei.swiped'],
      [`ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "supplierId" TEXT`, 'imei.supplierId'],
      [`ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "purchaseDate" TIMESTAMPTZ`, 'imei.purchaseDate'],
      [`ALTER TABLE imei_inventory ADD COLUMN IF NOT EXISTS "invoiceNo" TEXT`, 'imei.invoiceNo'],
      [`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false`, 'txn.isDeleted'],
      [`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ`, 'txn.deletedAt'],
      [`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS "deletedBy" TEXT`, 'txn.deletedBy'],
      [`UPDATE vendors SET "normalizedName" = lower(regexp_replace(trim(name), '\\s+', '', 'g')) WHERE "normalizedName" IS NULL`, 'backfill normalizedName'],
    ];
    const results: Record<string,string> = {};
    for (const [sql, label] of alters) {
      try { await client.query(sql); results[label] = 'OK'; }
      catch (e: any) { results[label] = e.message?.slice(0,80) || 'ERROR'; }
    }
    await client.end();
    return res.json({ ok: true, connected: connLabel, results });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
