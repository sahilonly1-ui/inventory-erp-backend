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
  // Visit https://inventory-erp-backend-iplr.onrender.com/db-setup to replay
  // the ENTIRE prisma/schema.sql against Supabase immediately (no redeploy
  // wait). Delegates to the same ensureSchema() that also runs automatically
  // on every server boot, so both paths always apply the exact same set of
  // statements — no more hand-picked subsets going stale.
  app.get('/db-setup', async (_req, res) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ensureSchema } = require('./server') as typeof import('./server');
      await ensureSchema();
      return res.json({ ok: true, message: 'Schema migration ran — check server logs for the applied/skipped/error counts.' });
    } catch (e: any) {
      return res.json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
