import express, { Application } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import cors from 'cors';
import crypto from 'crypto';
import { env } from './config/env';
import { globalLimiter } from './middlewares/rateLimiter';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import apiRoutes from './routes';
import { logger } from './config/logger';

export function createApp(): Application {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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

  // ── One-time DB setup endpoint ──────────────────────────────────────────────
  app.get('/db-setup', async (_req, res) => {
    try {
      const { ensureSchema } = require('./server') as typeof import('./server');
      await ensureSchema();
      return res.json({ ok: true, message: 'Schema migration ran — check server logs for the applied/skipped/error counts.' });
    } catch (e: any) {
      return res.json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ── Shopify OAuth ───────────────────────────────────────────────────────────
  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ?? '';
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET ?? '';
  const SHOPIFY_SCOPES = 'read_products,write_products,write_content';
  const SHOPIFY_REDIRECT_URI = 'https://inventory-erp-backend-iplr.onrender.com/auth/callback';

  // Step 1 — Start install: redirect browser to Shopify consent screen
  app.get('/auth', (req, res) => {
    const shop = req.query.shop as string;
    if (!shop) return res.status(400).send('Missing shop parameter');
    const installUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${SHOPIFY_API_KEY}` +
      `&scope=${SHOPIFY_SCOPES}` +
      `&redirect_uri=${encodeURIComponent(SHOPIFY_REDIRECT_URI)}`;
    return res.redirect(installUrl);
  });

  // Step 2 — Callback: verify HMAC, exchange code for access token
  app.get('/auth/callback', async (req, res) => {
    const { shop, hmac, code } = req.query as Record<string, string>;
    if (!shop || !hmac || !code) return res.status(400).send('Missing required params');

    // Verify Shopify HMAC signature
    const params = Object.entries(req.query)
      .filter(([k]) => k !== 'hmac')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');
    if (digest !== hmac) return res.status(403).send('HMAC validation failed');

    // Exchange code for permanent access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });
    const { access_token } = await tokenRes.json() as { access_token: string };

    // Log the token for now — save to DB when ready
    logger.info({ shop, access_token }, 'Shopify app installed');
    return res.send(`
      <h2>✅ iTechArena Content Automation installed successfully!</h2>
      <p>Shop: <strong>${shop}</strong></p>
      <p>You can close this tab.</p>
    `);
  });
  // ── End Shopify OAuth ───────────────────────────────────────────────────────

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
