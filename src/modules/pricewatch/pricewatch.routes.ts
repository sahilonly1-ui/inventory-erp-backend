import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { ForbiddenError, UnauthorizedError, BadRequestError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { WILDCARD } from '../../constants/permissions';
import { STORE_KEYS, StoreKey } from './stores';
import * as svc from './pricewatch.service';

const router = Router();

// ── Scraper bot (GitHub Actions / showroom PC) ─────────────────────────────
// Authenticated by a shared secret instead of a user login: the PRICE_AGENT_KEY
// env var on Render, sent as the x-agent-key header. It can only read the job
// list and post price results — nothing else in the ERP.
const botAuth = (req: Request, _res: Response, next: NextFunction) => {
  const key = process.env.PRICE_AGENT_KEY || '';
  const got = String(req.headers['x-agent-key'] ?? '');
  if (key.length < 20) return next(new ForbiddenError('Price bot not configured (PRICE_AGENT_KEY)'));
  if (got.length !== key.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key))) return next(new UnauthorizedError('Bad agent key'));
  next();
};
// Self-update for the showroom PC scraper: it asks for the current version of its
// files (served from this deploy's scraper folder) and replaces itself when they change.
const SCRAPER_FILES = ['index.mjs', 'lib.mjs', 'package.json'];
const scraperDir = () => require('path').join(process.cwd(), 'scraper');
router.get('/bot/scraper-version', botAuth, asyncHandler(async (_req, res) => {
  const fs = require('fs');
  const h = crypto.createHash('sha256');
  for (const f of SCRAPER_FILES) { try { h.update(f + '\0' + fs.readFileSync(require('path').join(scraperDir(), f))); } catch { /* missing */ } }
  ok(res, { version: h.digest('hex').slice(0, 16), files: SCRAPER_FILES });
}));
router.get('/bot/scraper-file/:name', botAuth, asyncHandler(async (req, res) => {
  const name = String(req.params.name);
  if (!SCRAPER_FILES.includes(name)) throw new BadRequestError('Unknown file');
  const fs = require('fs');
  ok(res, { name, content: fs.readFileSync(require('path').join(scraperDir(), name), 'utf8') });
}));

router.get('/bot/jobs', botAuth, asyncHandler(async (req, res) => {
  if (req.query.worker === 'local') svc.markLocalWorker();
  ok(res, await svc.agentJobs({ limit: Number(req.query.limit) || 100, maxLimit: 300, requestedOnly: req.query.queued === '1' }));
}));
router.post('/bot/results/:itemId', botAuth, asyncHandler(async (req, res) => {
  if (req.query.worker === 'local') svc.markLocalWorker();
  ok(res, await svc.agentSubmit(req.params.itemId, req.body?.results, req.query.worker === 'local' ? 'showroom-pc' : 'scraper'));
}));

// Signed-in administrators only (the wildcard permission). Market pricing is
// commercial information — staff roles never see it, whatever else they hold.
const adminOnly = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new UnauthorizedError());
  if (!req.user.permissions.has(WILDCARD)) return next(new ForbiddenError('Admins only'));
  next();
};
router.use(authenticate, adminOnly);

const storeParam = (s: string): StoreKey => {
  if (!STORE_KEYS.includes(s as StoreKey)) throw new BadRequestError('Unknown store');
  return s as StoreKey;
};

router.get('/items', asyncHandler(async (_req, res) => ok(res, { items: await svc.listItems(), status: await svc.status() })));
router.post('/items', asyncHandler(async (req, res) => ok(res, await svc.addItem(req.body ?? {}), 201)));
router.patch('/items/:id', asyncHandler(async (req, res) => { await svc.updateItem(req.params.id, req.body ?? {}); ok(res, { ok: true }); }));
router.delete('/items/:id', asyncHandler(async (req, res) => { await svc.removeItem(req.params.id); ok(res, { ok: true }); }));
router.post('/items/:id/request', asyncHandler(async (req, res) => { await svc.requestRefresh(req.params.id, !!req.body?.rediscover); ok(res, { ok: true }); }));
router.get('/items/:id/history', asyncHandler(async (req, res) => ok(res, await svc.history(req.params.id, Number(req.query.days) || 30))));
router.put('/items/:id/links/:store', asyncHandler(async (req, res) => {
  await svc.setLink(req.params.id, storeParam(req.params.store), req.body?.url || null, !!req.body?.notListed);
  ok(res, { ok: true });
}));
router.post('/sync', asyncHandler(async (_req, res) => ok(res, await svc.syncFromInventory())));
router.get('/settings', asyncHandler(async (_req, res) => ok(res, { ...(await svc.getSettings()), options: await svc.settingsOptions() })));
router.get('/run-status', asyncHandler(async (_req, res) => ok(res, await svc.runStatus())));
router.put('/settings', asyncHandler(async (req, res) => {
  const { options, ...body } = req.body ?? {};
  const saved = await svc.saveSettings(body);
  await svc.syncFromInventory();
  ok(res, saved);
}));

// Browser-agent endpoints (used by the /market-prices/agent page).
router.post('/agent/request', asyncHandler(async (req, res) => ok(res, await svc.requestMany(req.body?.ids, req.body?.replace !== false))));
router.get('/agent/jobs', asyncHandler(async (req, res) =>
  ok(res, await svc.agentJobs({
    itemId: req.query.item ? String(req.query.item) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    requestedOnly: req.query.queued === '1',
  }))));
router.post('/agent/results/:itemId', asyncHandler(async (req, res) =>
  ok(res, await svc.agentSubmit(req.params.itemId, req.body?.results))));

export default router;
