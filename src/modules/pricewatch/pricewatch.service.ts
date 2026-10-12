import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { STORES, STORE_KEYS, StoreKey, storeDef, officialDomains, normaliseStoreUrl, searchUrl } from './stores';

const q = <T = any>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const x = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p);

// ── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  autoSyncInStock: boolean;      // watch every product that has stock
  autoSyncCategories: string[];  // limit the sync to these categories (empty = all)
  defaultIntervalMins: number;   // an item is due for the agent after this
  priorityIntervalMins: number;  // …and starred items after this
  stores: StoreKey[];
  batchSize: number;             // products handed to the browser agent per run
}
const DEFAULTS: Settings = {
  autoSyncInStock: true,
  autoSyncCategories: [],
  defaultIntervalMins: 360,
  priorityIntervalMins: 60,
  stores: [...STORE_KEYS],
  batchSize: 5,
};

export async function getSettings(): Promise<Settings> {
  const rows = await q<{ value: any }>(`SELECT value FROM price_watch_settings WHERE key='main'`);
  return { ...DEFAULTS, ...(rows[0]?.value ?? {}) };
}
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = { ...cur, ...patch };
  next.stores = (next.stores ?? []).filter(s => STORE_KEYS.includes(s));
  next.defaultIntervalMins = Math.max(30, Math.round(next.defaultIntervalMins));
  next.priorityIntervalMins = Math.max(15, Math.round(next.priorityIntervalMins));
  next.batchSize = Math.min(25, Math.max(1, Math.round(next.batchSize)));
  await x(
    `INSERT INTO price_watch_settings(key,value,"updatedAt") VALUES('main',$1::jsonb,now())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=now()`,
    JSON.stringify(next),
  );
  return next;
}

// ── ERP sync ────────────────────────────────────────────────────────────────
// Products with stock become watch items automatically; when stock runs out
// an auto item is paused (not deleted — its history stays), and it resumes when
// stock comes back. Items the admin added by hand are never touched.

export async function syncFromInventory(): Promise<{ added: number; paused: number; resumed: number }> {
  const s = await getSettings();
  // Names and brands follow the Product Master.
  await x(`UPDATE price_watch_items i SET name=p.model, brand=p.brand, "updatedAt"=now()
           FROM products p WHERE p.id=i."productId" AND (i.name<>p.model OR i.brand IS DISTINCT FROM p.brand)`);
  if (!s.autoSyncInStock) return { added: 0, paused: 0, resumed: 0 };

  const catFilter = s.autoSyncCategories.length ? `AND c.name = ANY($1::text[])` : '';
  const params = s.autoSyncCategories.length ? [s.autoSyncCategories] : [];
  const stockSub = `(SELECT "productId", SUM(quantity)::int AS q FROM stock_levels GROUP BY "productId")`;

  const added = await x(
    `INSERT INTO price_watch_items("productId", name, brand, source)
     SELECT p.id, p.model, p.brand, 'auto'
     FROM products p
     JOIN ${stockSub} st ON st."productId"=p.id
     LEFT JOIN product_categories c ON c.id=p."categoryId"
     WHERE p."isDeleted"=false AND st.q>0 ${catFilter}
     ON CONFLICT ("productId") WHERE "productId" IS NOT NULL DO NOTHING`, ...params);

  const paused = await x(
    `UPDATE price_watch_items i SET active=false, "updatedAt"=now()
     WHERE i.source='auto' AND i.active=true AND i.priority=false
       AND COALESCE((SELECT SUM(quantity) FROM stock_levels sl WHERE sl."productId"=i."productId"),0) <= 0`);
  const resumed = await x(
    `UPDATE price_watch_items i SET active=true, "updatedAt"=now()
     WHERE i.source='auto' AND i.active=false AND i.dismissed=false
       AND COALESCE((SELECT SUM(quantity) FROM stock_levels sl WHERE sl."productId"=i."productId"),0) > 0`);
  return { added: Number(added), paused: Number(paused), resumed: Number(resumed) };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listItems() {
  await maybeSync();
  const items = await q(`
    SELECT i.*, p.ean, p."sellingPrice"::float AS "ourPrice", c.name AS category, COALESCE(st.q,0)::int AS stock
    FROM price_watch_items i
    LEFT JOIN products p ON p.id=i."productId"
    LEFT JOIN product_categories c ON c.id=p."categoryId"
    LEFT JOIN (SELECT "productId", SUM(quantity)::int AS q FROM stock_levels GROUP BY "productId") st ON st."productId"=i."productId"
    WHERE i.dismissed=false
    ORDER BY i.priority DESC, i.active DESC, i.name`);
  const ids = items.map(i => i.id);
  if (!ids.length) return [];

  const [latest, good, links] = await Promise.all([
    q(`SELECT DISTINCT ON ("itemId", store) * FROM price_snapshots WHERE "itemId" = ANY($1::text[]) ORDER BY "itemId", store, "fetchedAt" DESC`, ids),
    q(`SELECT DISTINCT ON ("itemId", store) * FROM price_snapshots WHERE "itemId" = ANY($1::text[]) AND status IN ('ok','suspect') ORDER BY "itemId", store, "fetchedAt" DESC`, ids),
    q(`SELECT * FROM price_watch_links WHERE "itemId" = ANY($1::text[])`, ids),
  ]);
  const num = (v: any) => (v === null || v === undefined ? null : Number(v));
  const clean = (s: any) => s && ({ ...s, price: num(s.price), mrp: num(s.mrp), effectivePrice: num(s.effectivePrice) });

  return items.map(i => {
    const stores: Record<string, any> = {};
    for (const k of STORE_KEYS) {
      const l = links.find(r => r.itemId === i.id && r.store === k);
      const last = latest.find(r => r.itemId === i.id && r.store === k);
      const g = good.find(r => r.itemId === i.id && r.store === k);
      stores[k] = { link: l ?? null, latest: clean(last) ?? null, lastGood: clean(g) ?? null };
    }
    return { ...i, stores };
  });
}

export async function history(itemId: string, days = 30) {
  const rows = await q(
    `SELECT store, price::float, "effectivePrice"::float, status, "fetchedAt" FROM price_snapshots
     WHERE "itemId"=$1 AND "fetchedAt" > now() - make_interval(days => $2::int) AND status IN ('ok','suspect')
     ORDER BY "fetchedAt"`, itemId, Math.round(days));
  return rows;
}

// ── Writing ─────────────────────────────────────────────────────────────────

export async function addItem(body: { productId?: string; name?: string; brand?: string; variant?: string; priority?: boolean }) {
  if (body.productId) {
    const p = await prisma.product.findFirst({ where: { id: body.productId, isDeleted: false } });
    if (!p) throw new NotFoundError('Product not found');
    const rows = await q(
      `INSERT INTO price_watch_items("productId",name,brand,variant,source,priority)
       VALUES($1,$2,$3,$4,'manual',$5)
       ON CONFLICT ("productId") WHERE "productId" IS NOT NULL
       DO UPDATE SET dismissed=false, active=true, variant=COALESCE(EXCLUDED.variant, price_watch_items.variant), "updatedAt"=now()
       RETURNING *`, p.id, p.model, p.brand, body.variant || null, !!body.priority);
    await requestRefresh(rows[0].id);
    return rows[0];
  }
  const name = body.name?.trim();
  if (!name) throw new BadRequestError('Product name is required');
  const rows = await q(
    `INSERT INTO price_watch_items(name,brand,variant,source,priority) VALUES($1,$2,$3,'manual',$4) RETURNING *`,
    name, body.brand?.trim() || null, body.variant?.trim() || null, !!body.priority);
  await requestRefresh(rows[0].id);
  return rows[0];
}

export async function updateItem(id: string, b: { active?: boolean; priority?: boolean; variant?: string | null; name?: string; brand?: string | null }) {
  const sets: string[] = []; const p: unknown[] = [];
  const add = (col: string, v: unknown) => { p.push(v); sets.push(`"${col}"=$${p.length}`); };
  if (b.active !== undefined) add('active', !!b.active);
  if (b.priority !== undefined) add('priority', !!b.priority);
  if (b.variant !== undefined) add('variant', b.variant?.trim() || null);
  if (b.name !== undefined && b.name.trim()) add('name', b.name.trim());
  if (b.brand !== undefined) add('brand', b.brand?.trim() || null);
  if (!sets.length) return;
  p.push(id);
  await x(`UPDATE price_watch_items SET ${sets.join(',')}, "updatedAt"=now() WHERE id=$${p.length}`, ...p);
  // A changed variant/name means the stored pages may be the wrong ones.
  if (b.variant !== undefined || b.name !== undefined) {
    await requestRefresh(id, true);
  }
}

export async function removeItem(id: string) {
  const rows = await q(`SELECT source FROM price_watch_items WHERE id=$1`, id);
  if (!rows.length) throw new NotFoundError('Item not found');
  // An auto item would just come back on the next sync, so it is hidden instead.
  if (rows[0].source === 'auto') await x(`UPDATE price_watch_items SET dismissed=true, active=false WHERE id=$1`, id);
  else await x(`DELETE FROM price_watch_items WHERE id=$1`, id);
}

export async function setLink(itemId: string, store: StoreKey, url: string | null, notListed = false) {
  const item = (await q(`SELECT brand FROM price_watch_items WHERE id=$1`, itemId))[0];
  if (!item) throw new NotFoundError('Item not found');
  if (!storeDef(store)) throw new BadRequestError('Unknown store');
  let clean: string | null = null;
  if (url) {
    clean = normaliseStoreUrl(store, url, item.brand);
    if (!clean) throw new BadRequestError(`That doesn't look like a ${storeDef(store)!.label} product page URL`);
  }
  // url=null & notListed=false → forget it and let discovery search again.
  const locked = !!clean || notListed;
  await x(
    `INSERT INTO price_watch_links("itemId",store,url,"lockedByUser","notListed","discoveredAt","updatedAt")
     VALUES($1,$2,$3,$4,$5,now(),now())
     ON CONFLICT("itemId",store) DO UPDATE SET url=EXCLUDED.url,"lockedByUser"=EXCLUDED."lockedByUser","notListed"=EXCLUDED."notListed","discoveredAt"=now(),"updatedAt"=now()`,
    itemId, store, clean, locked, notListed);
  if (!clean && !notListed) await x(`DELETE FROM price_watch_links WHERE "itemId"=$1 AND store=$2`, itemId, store);
  if (!notListed) await requestRefresh(itemId);
}

// ── Browser agent hand-off ──────────────────────────────────────────────────
// Prices are read by Claude in Chrome on the admin's own computer: a real
// browser on an Indian connection, so stores don't block it and JavaScript
// prices/offer popups render. It opens /market-prices/agent in the ERP, takes
// the jobs listed there, visits each store and posts what it saw back here.
// No paid API or scraping service is involved.

export async function requestRefresh(id: string, rediscover = false) {
  if (rediscover) await x(`DELETE FROM price_watch_links WHERE "itemId"=$1 AND "lockedByUser"=false`, id);
  await x(`UPDATE price_watch_items SET requested=true WHERE id=$1`, id);
}

/**
 * Queue exactly these products for the agent (the ones the admin has filtered
 * on screen). replace=true first clears any older queue, so the run checks
 * this set and nothing else.
 */
export async function requestMany(ids: string[], replace = true) {
  const clean = [...new Set((ids ?? []).filter(i => typeof i === 'string'))].slice(0, 1000);
  if (!clean.length) throw new BadRequestError('No products selected');
  if (replace) await x(`UPDATE price_watch_items SET requested=false WHERE requested=true`);
  const n = await x(
    `UPDATE price_watch_items SET requested=true WHERE id = ANY($1::text[]) AND active=true AND dismissed=false`, clean);
  const dispatched = await dispatchScraper(true);
  return { queued: Number(n), dispatched };
}

/**
 * Starts the GitHub Actions scraper right away (instead of waiting for its
 * schedule). Optional: needs GITHUB_DISPATCH_TOKEN on Render — a fine-grained
 * token with "Actions: read and write" on the backend repo. Never throws.
 */
export async function dispatchScraper(queuedOnly: boolean): Promise<boolean> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return false;
  const repo = process.env.GITHUB_SCRAPER_REPO || 'sahilonly1-ui/inventory-erp-backend';
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/price-scraper.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'itecharena-erp' },
      body: JSON.stringify({ ref: 'main', inputs: { queued_only: queuedOnly ? '1' : '0' } }),
    });
    if (!r.ok) logger.warn({ status: r.status, body: (await r.text()).slice(0, 200) }, 'price-watch: scraper dispatch failed');
    return r.ok;
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'price-watch: scraper dispatch failed');
    return false;
  }
}

/** The next batch for the agent: requested first, then starred/stalest due items. */
export async function agentJobs(opts: { itemId?: string; limit?: number; requestedOnly?: boolean; maxLimit?: number } = {}) {
  const s = await getSettings();
  await maybeSync();
  const limit = Math.min(opts.maxLimit ?? 25, Math.max(1, opts.limit ?? s.batchSize));
  const items = opts.itemId
    ? await q(`SELECT i.*, p.ean FROM price_watch_items i LEFT JOIN products p ON p.id=i."productId" WHERE i.id=$1`, opts.itemId)
    : opts.requestedOnly
    ? await q(
      `SELECT i.*, p.ean FROM price_watch_items i LEFT JOIN products p ON p.id=i."productId"
       WHERE i.requested AND i.active AND NOT i.dismissed
       ORDER BY i.priority DESC, i.name LIMIT $1::int`, limit)
    : await q(
      `SELECT i.*, p.ean FROM price_watch_items i LEFT JOIN products p ON p.id=i."productId"
       WHERE i.active=true AND i.dismissed=false AND (
         i.requested OR i."lastRefreshedAt" IS NULL OR
         i."lastRefreshedAt" < now() - make_interval(mins => (CASE WHEN i.priority THEN $1::int ELSE $2::int END)))
       ORDER BY i.requested DESC, i.priority DESC, i."lastRefreshedAt" NULLS FIRST LIMIT $3::int`,
      s.priorityIntervalMins, s.defaultIntervalMins, limit);
  if (!items.length) return [];
  const links = await q(`SELECT * FROM price_watch_links WHERE "itemId" = ANY($1::text[])`, items.map(i => i.id));
  return items.map(i => {
    const query = [i.name, i.variant].filter(Boolean).join(' ');
    const stores = STORES
      .filter(st => s.stores.includes(st.key))
      .filter(st => st.key !== 'official' || officialDomains(i.brand).length || links.some(l => l.itemId === i.id && l.store === 'official' && l.url))
      .map(st => {
        const l = links.find(r => r.itemId === i.id && r.store === st.key);
        if (l?.notListed && l.lockedByUser) return null; // admin said: not sold here
        return {
          store: st.key, label: st.label,
          url: l?.url ?? null,
          searchUrl: l?.url ? null : searchUrl(st.key, query, i.brand),
          officialSite: st.key === 'official' ? officialDomains(i.brand)[0] ?? null : undefined,
        };
      }).filter(Boolean);
    return { itemId: i.id, name: i.name, brand: i.brand, variant: i.variant, ean: i.ean, stores };
  });
}

export interface AgentOffer {
  bank?: string | null; cardType?: string | null; offerType?: string; mode?: string | null;
  amount?: number | null; percent?: number | null; maxDiscount?: number | null; minTxn?: number | null; summary?: string;
}
export interface AgentResult {
  store: string; url?: string | null; status?: string; price?: number | null; mrp?: number | null;
  inStock?: boolean | null; title?: string | null; priceText?: string | null; offers?: AgentOffer[]; note?: string | null;
}

const OFFER_TYPES = ['instant_discount', 'cashback', 'no_cost_emi', 'exchange', 'coupon', 'other'];
const numOrNull = (v: unknown) => { const n = Number(String(v ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

function offerValue(o: AgentOffer, price: number): number {
  if (!['instant_discount', 'cashback'].includes(o.offerType ?? '')) return 0;
  if (o.minTxn && price < o.minTxn) return 0;
  let v = o.amount ?? (o.percent ? (price * o.percent) / 100 : 0);
  if (o.maxDiscount) v = Math.min(v, o.maxDiscount);
  return Math.max(0, Math.round(v));
}

/** Checks one store result. Exported for tests. */
export function verify(r: AgentResult, expected: number | null, brand: string | null) {
  const store = r.store as StoreKey;
  const notes: string[] = [];
  const url = r.url ? normaliseStoreUrl(store, r.url, brand) : null;
  if (r.url && !url) notes.push('URL is not a product page on this store — ignored');
  const st = String(r.status ?? 'ok').toLowerCase();
  if (st === 'not_listed') return { status: 'not_listed', url: null, notes };
  const price = numOrNull(r.price);
  if (!price) return { status: st === 'blocked' ? 'blocked' : 'not_found', url, notes: [...notes, r.note || 'No price reported'] };
  if (!url) return { status: 'unverified', url: null, price, notes: [...notes, 'No valid product URL, so the price was not trusted'] };

  let status: 'ok' | 'suspect' = 'ok';
  if (expected && expected > 0 && (price < expected * 0.5 || price > expected * 1.8)) {
    status = 'suspect'; notes.push(`Far from expected ~₹${Math.round(expected).toLocaleString('en-IN')}`);
  }
  if (r.priceText && !String(r.priceText).replace(/[,\s]/g, '').includes(String(Math.round(price)))) {
    status = 'suspect'; notes.push(`Price text "${r.priceText}" doesn't match ₹${price}`);
  }
  const mrp0 = numOrNull(r.mrp);
  const mrp = mrp0 && mrp0 >= price ? mrp0 : null;

  const offers = (Array.isArray(r.offers) ? r.offers : []).slice(0, 25).map(o => {
    const clean: AgentOffer = {
      bank: o.bank ? String(o.bank).slice(0, 60) : null,
      cardType: o.cardType ? String(o.cardType).slice(0, 40) : null,
      offerType: OFFER_TYPES.includes(String(o.offerType)) ? String(o.offerType) : 'other',
      mode: o.mode ? String(o.mode).slice(0, 40) : null,
      amount: numOrNull(o.amount), percent: numOrNull(o.percent), maxDiscount: numOrNull(o.maxDiscount), minTxn: numOrNull(o.minTxn),
      summary: String(o.summary ?? '').slice(0, 300),
    };
    // A "discount" bigger than half the price is a misread, not an offer.
    const value = offerValue(clean, price);
    return { ...clean, value: value > price * 0.5 ? 0 : value };
  }).filter(o => o.summary || o.bank);

  const best = [...offers].sort((a, b) => b.value - a.value)[0];
  const effectivePrice = best && best.value > 0 ? price - best.value : null;
  const bestOffer = best && best.value > 0 ? [best.bank, best.cardType, best.mode].filter(Boolean).join(' · ') : null;
  if (r.note) notes.push(String(r.note).slice(0, 300));
  return {
    status, url, price, mrp, offers, effectivePrice, bestOffer, notes,
    inStock: typeof r.inStock === 'boolean' ? r.inStock : null,
    title: r.title ? String(r.title).slice(0, 300) : null,
    priceText: r.priceText ? String(r.priceText).slice(0, 80) : null,
  };
}

export async function agentSubmit(itemId: string, results: AgentResult[], method = 'chrome-agent') {
  const item = (await q(
    `SELECT i.*, p."sellingPrice"::float AS "ourPrice" FROM price_watch_items i LEFT JOIN products p ON p.id=i."productId" WHERE i.id=$1`, itemId))[0];
  if (!item) throw new NotFoundError('Item not found');
  if (!Array.isArray(results) || !results.length) throw new BadRequestError('No results');
  const prevGood = await q(
    `SELECT DISTINCT ON (store) store, price::float FROM price_snapshots WHERE "itemId"=$1 AND status='ok' ORDER BY store, "fetchedAt" DESC`, itemId);
  const links = await q(`SELECT * FROM price_watch_links WHERE "itemId"=$1`, itemId);

  const saved: { store: string; status: string; notes: string[] }[] = [];
  for (const r of results) {
    if (!storeDef(r.store)) continue;
    const link = links.find(l => l.store === r.store);
    const expected = prevGood.find(p => p.store === r.store)?.price ?? item.ourPrice ?? null;
    const v: any = verify(r, expected, item.brand);

    // Remember the page for next time — never over a URL the admin set.
    if (!link?.lockedByUser && (v.url || v.status === 'not_listed')) {
      await x(
        `INSERT INTO price_watch_links("itemId",store,url,"notListed","discoveredAt","updatedAt") VALUES($1,$2,$3,$4,now(),now())
         ON CONFLICT("itemId",store) DO UPDATE SET url=EXCLUDED.url,"notListed"=EXCLUDED."notListed","discoveredAt"=now(),"updatedAt"=now()
         WHERE price_watch_links."lockedByUser"=false`,
        itemId, r.store, v.url ?? null, v.status === 'not_listed');
    }
    if (v.status !== 'not_listed') {
      await x(
        `INSERT INTO price_snapshots("itemId",store,url,status,price,mrp,"inStock",title,offers,"effectivePrice","bestOffer","priceText",notes,method)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
        itemId, r.store, v.url ?? link?.url ?? null, v.status, v.price ?? null, v.mrp ?? null, v.inStock ?? null, v.title ?? null,
        JSON.stringify(v.offers ?? []), v.effectivePrice ?? null, v.bestOffer ?? null, v.priceText ?? null, (v.notes ?? []).join(' · ') || null, method);
    }
    saved.push({ store: r.store, status: v.status, notes: v.notes });
  }
  await x(`UPDATE price_watch_items SET "lastRefreshedAt"=now(), requested=false WHERE id=$1`, itemId);
  await x(`INSERT INTO price_watch_settings(key,value,"updatedAt") VALUES('lastAgentRun',$1::jsonb,now())
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=now()`, JSON.stringify({ at: new Date().toISOString() }));
  return { saved };
}

export async function status() {
  const [r] = await q(`SELECT
      (SELECT value->>'at' FROM price_watch_settings WHERE key='lastAgentRun') AS "lastAgentRun",
      ${process.env.GITHUB_DISPATCH_TOKEN ? 'true' : 'false'} AS "instantRun",
      (SELECT COUNT(*)::int FROM price_watch_items WHERE requested AND active AND NOT dismissed) AS requested`);
  return r;
}

// ── Housekeeping (sync with stock, prune old snapshots) ─────────────────────

let lastSync = 0, lastCleanup = 0;
async function maybeSync() {
  if (Date.now() - lastSync < 30 * 60_000) return;
  lastSync = Date.now();
  try { await syncFromInventory(); } catch (e: any) { logger.error({ err: e?.message }, 'price-watch: sync failed'); }
}
export async function tick() {
  await maybeSync();
  if (Date.now() - lastCleanup > 24 * 3600_000) {
    await x(`DELETE FROM price_snapshots WHERE "fetchedAt" < now() - interval '90 days'`);
    lastCleanup = Date.now();
  }
}
