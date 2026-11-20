import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { STORES, STORE_KEYS, StoreKey, storeDef, officialDomains, normaliseStoreUrl, normaliseAdminUrl, searchUrl, resolveLink, isShortLink, storeOfUrl } from './stores';
import { sellableStockSql } from '../../common/sellableStock';
import { notListedRetryHours, leadingNotListed } from './notListed';
import { variantName, variantKey } from './variant';

const q = <T = any>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const x = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p);

// ── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  autoSyncInStock: boolean;      // watch every product that has stock
  autoSyncCategories: string[];  // limit the sync to these categories (empty = all)
  autoSyncBrands: string[];      // …and to these brands (empty = all)
  includeOutOfStock: boolean;    // also watch products of those brands/categories with no stock
  defaultIntervalMins: number;   // an item is due for the agent after this
  priorityIntervalMins: number;  // …and starred items after this
  stores: StoreKey[];
  batchSize: number;             // products handed to the browser agent per run
}
// The brands and categories iTechArena tracks by default (editable in Settings).
// The brand list that used to ship as the default. Every brand not on it — Ai+, HMD, Tecno, Realme,
// Vivo, Redmi … — was silently never watched, however much of it was in stock. The default is now
// every brand; a saved list that is still exactly this old default is treated as never chosen.
export const LEGACY_DEFAULT_BRANDS = ['Amazon', 'Apple', 'Boat', 'Carvaan', 'Google', 'JBL', 'Marshall', 'Motorola', 'Noise', 'Nothing', 'OnePlus', 'OPPO', 'Samsung'];
export const DEFAULT_CATEGORIES = ['Amazon & TV Stick', 'EarBuds', 'Headphones', 'LED TV', 'Party Speaker', 'Smartphone', 'SmartWatch', 'Soundbars', 'Speaker', 'Tabs'];

const DEFAULTS: Settings = {
  autoSyncInStock: true,
  autoSyncCategories: DEFAULT_CATEGORIES,
  autoSyncBrands: [],              // every brand
  includeOutOfStock: false,
  defaultIntervalMins: 360,
  priorityIntervalMins: 60,
  stores: [...STORE_KEYS],
  batchSize: 5,
};

const sameNames = (a: string[], b: string[]) => {
  const A = new Set(a.map(x => String(x).trim().toLowerCase())), B = new Set(b.map(x => x.toLowerCase()));
  return A.size === B.size && [...A].every(x => B.has(x));
};

export async function getSettings(): Promise<Settings> {
  const rows = await q<{ value: any }>(`SELECT value FROM price_watch_settings WHERE key='main'`);
  const saved = { ...(rows[0]?.value ?? {}) };
  // Settings saved before brand filtering existed: start from the default lists.
  if (saved.autoSyncBrands === undefined) { delete saved.autoSyncCategories; }
  // A list nobody chose — the old shipped default, saved unchanged — means "all brands".
  if (Array.isArray(saved.autoSyncBrands) && sameNames(saved.autoSyncBrands, LEGACY_DEFAULT_BRANDS)) saved.autoSyncBrands = [];
  return { ...DEFAULTS, ...saved };
}
/** Every brand and category in the Product Master, for the Settings pickers. */
export async function settingsOptions() {
  const [brands, cats] = await Promise.all([
    q<{ b: string }>(`SELECT DISTINCT ON (lower(brand)) brand AS b FROM products WHERE "isDeleted"=false AND brand IS NOT NULL AND brand<>'' ORDER BY lower(brand), brand`),
    q<{ c: string }>(`SELECT name AS c FROM product_categories ORDER BY 1`),
  ]);
  return { brands: brands.map(r => r.b), categories: cats.map(r => r.c) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = { ...cur, ...patch };
  next.stores = (next.stores ?? []).filter(s => STORE_KEYS.includes(s));
  next.autoSyncBrands = [...new Set((next.autoSyncBrands ?? []).map(String).map(x => x.trim()).filter(Boolean))];
  next.autoSyncCategories = [...new Set((next.autoSyncCategories ?? []).map(String).map(x => x.trim()).filter(Boolean))];
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

export async function syncFromInventory(): Promise<{ added: number; paused: number; resumed: number; merged: number }> {
  const s = await getSettings();

  // A product is "in scope" when its brand and category are on the lists
  // (case-insensitive; an empty list means any) and, unless out-of-stock
  // products are included, it has sellable stock (Stock Report rule).
  const stockOf = `COALESCE(${sellableStockSql('p')}, 0)`;
  const params = [s.autoSyncBrands.map(b => b.toLowerCase()), s.autoSyncCategories.map(c => c.toLowerCase()), s.includeOutOfStock, !!s.autoSyncInStock];
  // In-scope products, plus every product an item already points at (so a hand-added
  // product is grouped with its other colours too). One query, everything in memory.
  const prods = await q<{ id: string; model: string; brand: string | null; stock: number; inScope: boolean }>(`
    WITH base AS (
      SELECT p.id, p.model, p.brand, ${stockOf}::int AS stock,
        ($4::boolean
          AND (cardinality($1::text[])=0 OR lower(p.brand) = ANY($1::text[]))
          AND (cardinality($2::text[])=0 OR lower(c.name) = ANY($2::text[]))) AS listed
      FROM products p LEFT JOIN product_categories c ON c.id=p."categoryId"
      WHERE p."isDeleted"=false
        AND (EXISTS (SELECT 1 FROM price_watch_items i WHERE i."productId"=p.id)
          OR ($4::boolean
            AND (cardinality($1::text[])=0 OR lower(p.brand) = ANY($1::text[]))
            AND (cardinality($2::text[])=0 OR lower(c.name) = ANY($2::text[]))))
    )
    SELECT id, model, brand, stock, (listed AND ($3::boolean OR stock > 0)) AS "inScope" FROM base`, ...params);
  const items = await q<{ id: string; productId: string | null; groupKey: string | null; name: string; brand: string | null; source: string; priority: boolean; active: boolean; dismissed: boolean }>(
    `SELECT id, "productId", "groupKey", name, brand, source, priority, active, dismissed FROM price_watch_items`);
  const mapRows = await q<{ itemId: string; productId: string }>(`SELECT "itemId", "productId" FROM price_watch_group_products`);

  // Group products by brand + colour-free name.
  type G = { key: string; name: string; brand: string | null; products: typeof prods; inScope: boolean };
  const groups = new Map<string, G>();
  for (const p of prods) {
    const key = variantKey(p.brand, p.model);
    let g = groups.get(key);
    if (!g) { g = { key, name: variantName(p.model), brand: p.brand, products: [], inScope: false }; groups.set(key, g); }
    g.products.push(p);
    if (p.inScope) g.inScope = true;
  }
  const itemByKey = new Map(items.filter(i => i.groupKey).map(i => [i.groupKey!, i]));
  const itemsByProduct = new Map<string, typeof items>();
  for (const i of items) if (i.productId) itemsByProduct.set(i.productId, [...(itemsByProduct.get(i.productId) ?? []), i]);

  const toInsert: { key: string; name: string; brand: string | null; rep: string }[] = [];
  const toRename: { id: string; key: string; name: string; brand: string | null }[] = [];
  const merges: { loser: string; keeper: string }[] = [];
  const raise: { id: string; priority: boolean; manual: boolean }[] = [];
  const keeperOf = new Map<string, string>();         // group key → item id (existing only)

  for (const g of groups.values()) {
    // Only groups that are in scope or already watched become / stay items.
    const related = new Map<string, (typeof items)[number]>();
    const byKey = itemByKey.get(g.key); if (byKey) related.set(byKey.id, byKey);
    for (const p of g.products) for (const i of itemsByProduct.get(p.id) ?? []) related.set(i.id, i);
    if (!related.size && !g.inScope) continue;
    const rep = [...g.products].sort((a, b) => b.stock - a.stock)[0];
    if (!related.size) { toInsert.push({ key: g.key, name: g.name, brand: g.brand, rep: rep.id }); continue; }
    // Keeper: the item already holding this key, else a visible one, else a starred/hand-added one.
    const cands = [...related.values()].sort((a, b) =>
      Number(b.groupKey === g.key) - Number(a.groupKey === g.key) || Number(a.dismissed) - Number(b.dismissed)
      || Number(b.priority) - Number(a.priority) || Number(b.source === 'manual') - Number(a.source === 'manual'));
    const keeper = cands[0];
    keeperOf.set(g.key, keeper.id);
    if (keeper.groupKey !== g.key || keeper.name !== g.name || keeper.brand !== g.brand) toRename.push({ id: keeper.id, key: g.key, name: g.name, brand: g.brand });
    const losers = cands.slice(1);
    for (const l of losers) merges.push({ loser: l.id, keeper: keeper.id });
    if (losers.some(l => l.priority && !keeper.priority) || losers.some(l => l.source === 'manual' && keeper.source !== 'manual') || (keeper.dismissed && losers.some(l => !l.dismissed))) {
      raise.push({ id: keeper.id, priority: keeper.priority || losers.some(l => l.priority), manual: keeper.source === 'manual' || losers.some(l => l.source === 'manual') });
    }
  }

  // 1. Merge items of the same variant into one: history and pages move to the keeper.
  if (merges.length) {
    const L = merges.map(m => m.loser), K = merges.map(m => m.keeper);
    await x(`UPDATE price_snapshots s SET "itemId"=m.keeper FROM unnest($1::text[], $2::text[]) AS m(loser, keeper) WHERE s."itemId"=m.loser`, L, K);
    // A page the admin set on any colour wins over one found automatically.
    await x(`INSERT INTO price_watch_links("itemId",store,url,"lockedByUser","notListed","discoveredAt","updatedAt")
             SELECT DISTINCT ON (m.keeper, l.store) m.keeper, l.store, l.url, l."lockedByUser", l."notListed", l."discoveredAt", now()
             FROM price_watch_links l JOIN unnest($1::text[], $2::text[]) AS m(loser, keeper) ON l."itemId"=m.loser
             ORDER BY m.keeper, l.store, l."lockedByUser" DESC, (l.url IS NOT NULL) DESC, l."updatedAt" DESC
             ON CONFLICT("itemId",store) DO UPDATE SET url=EXCLUDED.url, "lockedByUser"=EXCLUDED."lockedByUser", "notListed"=EXCLUDED."notListed", "updatedAt"=now()
             WHERE price_watch_links."lockedByUser"=false AND (EXCLUDED."lockedByUser" OR price_watch_links.url IS NULL)`, L, K);
    await x(`DELETE FROM price_watch_items WHERE id = ANY($1::text[])`, L);
  }
  if (raise.length) {
    await x(`UPDATE price_watch_items i SET priority=r.priority, source=CASE WHEN r.manual THEN 'manual' ELSE i.source END, dismissed=false, "updatedAt"=now()
             FROM unnest($1::text[], $2::boolean[], $3::boolean[]) AS r(id, priority, manual) WHERE i.id=r.id`,
      raise.map(r => r.id), raise.map(r => r.priority), raise.map(r => r.manual));
  }
  // 2. Keepers take the variant name (no colour).
  if (toRename.length) {
    await x(`UPDATE price_watch_items i SET "groupKey"=r.key, name=r.name, brand=r.brand, "updatedAt"=now()
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS r(id, key, name, brand) WHERE i.id=r.id`,
      toRename.map(r => r.id), toRename.map(r => r.key), toRename.map(r => r.name), toRename.map(r => r.brand));
  }
  // 3. New variants in stock.
  let added = 0;
  if (toInsert.length) {
    const rows = await q<{ id: string; groupKey: string }>(
      `INSERT INTO price_watch_items("productId", "groupKey", name, brand, source)
       SELECT r.rep, r.key, r.name, r.brand, 'auto' FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS r(key, name, brand, rep)
       ON CONFLICT DO NOTHING RETURNING id, "groupKey"`,
      toInsert.map(r => r.key), toInsert.map(r => r.name), toInsert.map(r => r.brand), toInsert.map(r => r.rep));
    added = rows.length;
    for (const r of rows) keeperOf.set(r.groupKey, r.id);
  }
  // 4. Which products (colours) belong to which item — rewritten only when it changed.
  const want = new Map<string, string>();
  for (const g of groups.values()) { const id = keeperOf.get(g.key); if (id) for (const p of g.products) want.set(p.id, id); }
  const have = new Map(mapRows.map(r => [r.productId, r.itemId]));
  const changed = [...want].filter(([pid, iid]) => have.get(pid) !== iid);
  if (changed.length) {
    await x(`INSERT INTO price_watch_group_products("productId","itemId") SELECT * FROM unnest($1::text[], $2::text[])
             ON CONFLICT("productId") DO UPDATE SET "itemId"=EXCLUDED."itemId"`, changed.map(c => c[0]), changed.map(c => c[1]));
  }
  // 5. Auto items follow stock: paused when no colour of the variant is in scope, resumed when one is.
  const inScopeIds = [...groups.values()].filter(g => g.inScope).map(g => keeperOf.get(g.key)).filter(Boolean) as string[];
  const live = new Set(inScopeIds);
  const after = items.filter(i => !merges.some(m => m.loser === i.id));
  const pauseIds = after.filter(i => i.source === 'auto' && i.active && !i.priority && i.productId && !live.has(i.id)).map(i => i.id);
  const resumeIds = after.filter(i => i.source === 'auto' && !i.active && !i.dismissed && live.has(i.id)).map(i => i.id);
  if (pauseIds.length) await x(`UPDATE price_watch_items SET active=false, requested=false, "updatedAt"=now() WHERE id = ANY($1::text[])`, pauseIds);
  if (resumeIds.length) await x(`UPDATE price_watch_items SET active=true, "updatedAt"=now() WHERE id = ANY($1::text[])`, resumeIds);
  if (merges.length || added) logger.info({ merged: merges.length, added, paused: pauseIds.length, resumed: resumeIds.length }, 'price-watch: synced by variant');
  return { added, paused: pauseIds.length, resumed: resumeIds.length, merged: merges.length };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listItems() {
  await maybeSync();
  const items = await q(`
    SELECT i.*, p.ean, p."sellingPrice"::float AS "ourPrice",
           COALESCE((SELECT MIN(sp2.price) FROM price_watch_group_products g2 JOIN spec_prices sp2 ON sp2."productId"=g2."productId" WHERE g2."itemId"=i.id), sp.price)::float AS "specPrice",
           c.name AS category,
           COALESCE((SELECT SUM(${sellableStockSql('p2')}) FROM price_watch_group_products g2 JOIN products p2 ON p2.id=g2."productId" WHERE g2."itemId"=i.id),
                    ${sellableStockSql('p')}, 0)::int AS stock,
           (SELECT COUNT(*)::int FROM price_watch_group_products g3 WHERE g3."itemId"=i.id) AS colours
    FROM price_watch_items i
    LEFT JOIN products p ON p.id=i."productId"
    LEFT JOIN product_categories c ON c.id=p."categoryId"
    LEFT JOIN spec_prices sp ON sp."productId"=i."productId"
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
    // Another colour of this variant is already watched: that entry covers it.
    const existing = (await q(`SELECT i.* FROM price_watch_items i WHERE i."groupKey"=$1`, variantKey(p.brand, p.model)))[0];
    if (existing) {
      await x(`UPDATE price_watch_items SET dismissed=false, active=true, priority=(priority OR $2), "updatedAt"=now() WHERE id=$1`, existing.id, !!body.priority);
      await x(`INSERT INTO price_watch_group_products("productId","itemId") VALUES($1,$2) ON CONFLICT("productId") DO UPDATE SET "itemId"=EXCLUDED."itemId"`, p.id, existing.id);
      await requestRefresh(existing.id);
      return existing;
    }
    const rows = await q(
      `INSERT INTO price_watch_items("productId",name,brand,variant,source,priority)
       VALUES($1,$2,$3,$4,'manual',$5)
       ON CONFLICT ("productId") WHERE "productId" IS NOT NULL
       DO UPDATE SET dismissed=false, active=true, variant=COALESCE(EXCLUDED.variant, price_watch_items.variant), "updatedAt"=now()
       RETURNING *`, p.id, variantName(p.model), p.brand, body.variant || null, !!body.priority);
    await x(`UPDATE price_watch_items SET "groupKey"=$2 WHERE id=$1`, rows[0].id, variantKey(p.brand, p.model));
    await x(`INSERT INTO price_watch_group_products("productId","itemId") VALUES($1,$2) ON CONFLICT("productId") DO UPDATE SET "itemId"=EXCLUDED."itemId"`, p.id, rows[0].id);
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
    let full = url.trim();
    if (!/^https?:\/\//i.test(full)) full = 'https://' + full;
    // Share links (amzn.in/d/…, dl.flipkart.com/s/…) are followed to the real page.
    if (isShortLink(full)) full = await resolveLink(full);
    // An Amazon link pasted under Flipkart (or similar) is saved under the store it belongs to.
    const owner = storeOfUrl(full);
    if (owner && owner !== store) store = owner;
    clean = normaliseAdminUrl(store, full, item.brand);
    if (!clean) {
      throw new BadRequestError(isShortLink(full)
        ? `Couldn't open that share link from the server. Open it in your browser and paste the full ${storeDef(store)!.label} page address instead.`
        : `That link isn't a ${storeDef(store)!.label} page. Paste the product page link from ${storeDef(store)!.label}.`);
    }
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

// How long a store is left alone after "not listed" depends on how many checks in a row said so (notListed.ts).

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
  // The showroom PC scraper picks queued items up within seconds by itself;
  // only start the (slower) GitHub run when it is offline.
  if (localWorkerOnline()) return { queued: Number(n), dispatched: true, via: 'local' };
  const dispatched = await dispatchScraper(true);
  return { queued: Number(n), dispatched, via: 'cloud' };
}

// ── Showroom PC scraper heartbeat ───────────────────────────────────────────
// Every poll and every saved result from the always-on scraper marks it alive.
let localSeen = 0;
export function markLocalWorker() { localSeen = Date.now(); }
export function localWorkerOnline() { return Date.now() - localSeen < 90_000; }

let runCache: { at: number; data: any } | null = null;
/** Latest scraper run on GitHub (status, start time, link), cached for 15 s. */
export async function runStatus() {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return { configured: false };
  if (runCache && Date.now() - runCache.at < 15_000) return runCache.data;
  const repo = process.env.GITHUB_SCRAPER_REPO || 'sahilonly1-ui/inventory-erp-backend';
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/price-scraper.yml/runs?per_page=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'itecharena-erp' },
    });
    const j: any = await r.json();
    const run = j?.workflow_runs?.[0];
    const data = {
      configured: r.ok, error: r.ok ? undefined : (j?.message || `GitHub ${r.status}`),
      run: run ? { number: run.run_number, status: run.status, conclusion: run.conclusion, startedAt: run.run_started_at || run.created_at, updatedAt: run.updated_at, url: run.html_url } : null,
    };
    runCache = { at: Date.now(), data };
    return data;
  } catch (e: any) {
    return { configured: true, error: e?.message || 'GitHub unreachable' };
  }
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
    runCache = null;
    // GitHub sometimes answers 5xx although the run was created — treat as started
    // (the run status line on the page shows whether it really is running).
    return r.ok || r.status >= 500;
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
       ORDER BY i.requested DESC, i.priority DESC,
                -- a product that has never produced a price is looked at before one that is merely due again
                (NOT EXISTS (SELECT 1 FROM price_snapshots g WHERE g."itemId"=i.id AND g.status IN ('ok','suspect'))) DESC,
                i."lastRefreshedAt" NULLS FIRST LIMIT $3::int`,
      s.priorityIntervalMins, s.defaultIntervalMins, limit);
  if (!items.length) return [];
  const links = await q(`SELECT * FROM price_watch_links WHERE "itemId" = ANY($1::text[])`, items.map(i => i.id));
  // The latest few results per store, to tell a store that has said "not listed"
  // once (maybe a bad search) from one that has said so repeatedly.
  const recent = await q<{ itemId: string; store: string; recent: string[] }>(
    `SELECT "itemId", store, (array_agg(status ORDER BY "fetchedAt" DESC))[1:3] AS recent
     FROM price_snapshots WHERE "itemId" = ANY($1::text[]) AND "fetchedAt" > now() - interval '30 days'
     GROUP BY "itemId", store`, items.map(i => i.id));
  const recentBy = new Map<string, string[]>(recent.map(r => [`${r.itemId}|${r.store}`, r.recent ?? []] as [string, string[]]));
  return items.map(i => {
    const query = [i.name, i.variant].filter(Boolean).join(' ');
    const stores = STORES
      .filter(st => s.stores.includes(st.key))
      .filter(st => st.key !== 'official' || officialDomains(i.brand).length || links.some(l => l.itemId === i.id && l.store === 'official' && l.url))
      .map(st => {
        const l = links.find(r => r.itemId === i.id && r.store === st.key);
        if (l?.notListed && l.lockedByUser) return null; // admin said: not sold here
        // Searched recently and not sold there — skip for a few days instead of
        // searching again every run ("Re-find pages" clears this immediately).
        // A product refreshed by hand ("requested") is searched on every store again.
        const streak = leadingNotListed(recentBy.get(`${i.id}|${st.key}`) ?? []);
        // (Searched again on every run now: a listing that wasn't found last time
        // often turns up the next time. Only the admin's own "not sold here" is skipped.)
        void streak; void notListedRetryHours;
        return {
          store: st.key, label: st.label,
          url: l?.url ?? null,
          locked: !!l?.lockedByUser,   // pasted by the admin — never second-guessed
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
export function verify(r: AgentResult, expected: number | null, brand: string | null, erpMrp: number | null = null, adminUrl = false) {
  const store = r.store as StoreKey;
  const notes: string[] = [];
  const url = r.url ? (adminUrl ? normaliseAdminUrl(store, r.url, brand) : normaliseStoreUrl(store, r.url, brand)) : null;
  if (r.url && !url) notes.push('URL is not a product page on this store — ignored');
  const st = String(r.status ?? 'ok').toLowerCase();
  if (st === 'not_listed') return { status: 'not_listed', url: null, notes };
  const price = numOrNull(r.price);
  if (!price) return { status: st === 'blocked' ? 'blocked' : 'not_found', url, notes: [...notes, r.note || 'No price reported'] };
  if (!url) return { status: 'unverified', url: null, price, notes: [...notes, 'No valid product URL, so the price was not trusted'] };

  let status: 'ok' | 'suspect' = st === 'suspect' ? 'suspect' : 'ok';
  // Plausibility: against the ERP's MRP when known (selling above MRP, or below
  // 30% of it, is not a real listing); otherwise against the last good price.
  if (erpMrp && erpMrp > 0) {
    if (price > erpMrp * 1.15 || price < erpMrp * 0.3) { status = 'suspect'; notes.push(`Unusual vs MRP ₹${Math.round(erpMrp).toLocaleString('en-IN')}`); }
  } else if (expected && expected > 0 && (price < expected * 0.5 || price > expected * 1.8)) {
    status = 'suspect'; notes.push(`Far from last price ~₹${Math.round(expected).toLocaleString('en-IN')}`);
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

  // "Best deal" is what a customer pays on a full (non-EMI) payment; EMI-only
  // savings are still listed under the store but don't set the effective price.
  const best = offers.filter(o => !/^emi$/i.test(String(o.mode ?? '').trim()) && o.offerType !== 'no_cost_emi')
    .sort((a, b) => b.value - a.value)[0];
  const effectivePrice = best && best.value > 0 ? price - best.value : null;
  const bestOffer = best && best.value > 0 ? [best.bank, best.cardType, best.mode].filter(Boolean).join(' · ') : null;
  if (r.note) notes.push(String(r.note).slice(0, /^Stock from:/.test(String(r.note)) ? 1100 : 300));
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
  if (!Array.isArray(results)) throw new BadRequestError('results must be a list');
  const prevGood = await q(
    `SELECT DISTINCT ON (store) store, price::float FROM price_snapshots WHERE "itemId"=$1 AND status='ok' ORDER BY store, "fetchedAt" DESC`, itemId);
  const links = await q(`SELECT * FROM price_watch_links WHERE "itemId"=$1`, itemId);

  const saved: { store: string; status: string; notes: string[] }[] = [];
  for (const r of results) {
    if (!storeDef(r.store)) continue;
    const link = links.find(l => l.store === r.store);
    const expected = prevGood.find(p => p.store === r.store)?.price ?? null;
    const v: any = verify(r, expected, item.brand, item.ourPrice ?? null, !!link?.lockedByUser);

    // Amazon often has one page per colour, and one colour can be "currently unavailable"
    // while another sells. A page found automatically that says unavailable is forgotten,
    // so the next run searches again and can land on a colour that is in stock.
    if (r.store === 'amazon' && !link?.lockedByUser && v.status === 'not_found' && /not sold on amazon right now/i.test(String(r.note ?? ''))) {
      await x(`DELETE FROM price_watch_links WHERE "itemId"=$1 AND store='amazon' AND "lockedByUser"=false`, itemId);
      v.url = null;
    }
    if (!link?.lockedByUser && link?.url && v.status === 'not_found') {
      const prev = (await q(`SELECT status FROM price_snapshots WHERE "itemId"=$1 AND store=$2 ORDER BY "fetchedAt" DESC LIMIT 1`, itemId, r.store))[0];
      if (prev && prev.status !== 'ok' && prev.status !== 'suspect') {
        await x(`DELETE FROM price_watch_links WHERE "itemId"=$1 AND store=$2 AND "lockedByUser"=false`, itemId, r.store);
        v.url = null;
      }
    }
    // Remember the page for next time — never over a URL the admin set.
    if (!link?.lockedByUser && (v.url || v.status === 'not_listed')) {
      await x(
        `INSERT INTO price_watch_links("itemId",store,url,"notListed","discoveredAt","updatedAt") VALUES($1,$2,$3,$4,now(),now())
         ON CONFLICT("itemId",store) DO UPDATE SET url=EXCLUDED.url,"notListed"=EXCLUDED."notListed","discoveredAt"=now(),"updatedAt"=now()
         WHERE price_watch_links."lockedByUser"=false`,
        itemId, r.store, v.url ?? null, v.status === 'not_listed');
    }
    {
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

/**
 * Brands with sellable stock, in the watched categories, that the brand list leaves out —
 * so a brand missing from Market Prices is visible on the page instead of just absent.
 */
export async function notWatchedBrands(): Promise<{ brand: string; products: number }[]> {
  const s = await getSettings();
  if (!s.autoSyncInStock || !s.autoSyncBrands.length) return [];
  const rows = await q<{ brand: string; products: number }>(
    `SELECT p.brand AS brand, COUNT(*)::int AS products
     FROM products p LEFT JOIN product_categories c ON c.id=p."categoryId"
     WHERE p."isDeleted"=false AND p.brand IS NOT NULL AND p.brand <> ''
       AND NOT (lower(p.brand) = ANY($1::text[]))
       AND (cardinality($2::text[])=0 OR lower(c.name) = ANY($2::text[]))
       AND ${sellableStockSql('p')} > 0
     GROUP BY p.brand ORDER BY COUNT(*) DESC, p.brand`,
    s.autoSyncBrands.map(b => b.toLowerCase()), s.autoSyncCategories.map(c => c.toLowerCase()));
  return rows;
}

export async function status() {
  const [r] = await q(`SELECT
      (SELECT value->>'at' FROM price_watch_settings WHERE key='lastAgentRun') AS "lastAgentRun",
      ${process.env.GITHUB_DISPATCH_TOKEN ? 'true' : 'false'} AS "instantRun",
      ${localWorkerOnline() ? 'true' : 'false'} AS "localOnline",
      ${localSeen ? `'${new Date(localSeen).toISOString()}'` : 'NULL'} AS "localSeen",
      (SELECT COUNT(*)::int FROM price_watch_items WHERE requested AND active AND NOT dismissed) AS requested`);
  return { ...r, notWatchedBrands: await notWatchedBrands().catch(() => []) };
}

// ── Housekeeping (sync with stock, prune old snapshots) ─────────────────────

let lastSync = 0, lastCleanup = 0;
/**
 * Once: forget the "not sold on this store" verdicts recorded before a verdict needed a page
 * that was really read. Many of them were a blank page or an unloaded sitemap, repeated run
 * after run — and a store that has said "not listed" three times running is now left alone for
 * three days, so that old, wrong history would have kept those stores unchecked. Verdicts the
 * admin set by hand are kept. A marker row makes sure this happens only once.
 */
let resetDone = false;
async function resetOldNotListed() {
  if (resetDone) return;
  resetDone = true;
  const marker = await q(`SELECT 1 FROM price_watch_settings WHERE key='notListedReset2026_11'`);
  if (marker.length) return;
  const n = await x(`UPDATE price_watch_links SET "notListed"=false WHERE "notListed"=true AND "lockedByUser"=false`);
  await x(`INSERT INTO price_watch_settings(key,value,"updatedAt") VALUES('notListedReset2026_11',$1::jsonb,now()) ON CONFLICT(key) DO NOTHING`,
    JSON.stringify({ cleared: Number(n), at: new Date().toISOString() }));
  logger.info({ cleared: Number(n) }, 'price-watch: old not-listed verdicts cleared');
}

async function maybeSync() {
  try { await resetOldNotListed(); } catch (e: any) { logger.error({ err: e?.message }, 'price-watch: not-listed reset failed'); }
  if (Date.now() - lastSync < 30 * 60_000) return;
  lastSync = Date.now();
  try { await syncFromInventory(); } catch (e: any) { logger.error({ err: e?.message }, 'price-watch: sync failed'); }
}
// GitHub's own schedule for the cloud scraper is unreliable (runs are delayed or
// skipped — only 2–3 a day actually happened, so most prices were 12+ hours old).
// The ERP now starts a run itself whenever prices are due and the showroom PC
// scraper is offline: at most one every 2 hours, never while one is running.
let lastAutoDispatch = 0;
async function autoDispatch() {
  if (!process.env.GITHUB_DISPATCH_TOKEN || localWorkerOnline()) return;
  if (Date.now() - lastAutoDispatch < 2 * 3600_000) return;
  const s = await getSettings();
  const [due] = await q<{ n: number }>(
    `SELECT COUNT(*)::int n FROM price_watch_items WHERE active AND NOT dismissed AND (requested OR "lastRefreshedAt" IS NULL OR
       "lastRefreshedAt" < now() - make_interval(mins => (CASE WHEN priority THEN $1::int ELSE $2::int END)))`,
    s.priorityIntervalMins, s.defaultIntervalMins);
  if (!due?.n) return;
  const st: any = await runStatus();
  if (st?.run && st.run.status !== 'completed') return;                       // one is already running
  if (st?.run?.startedAt && Date.now() - new Date(st.run.startedAt).getTime() < 90 * 60_000) return;
  lastAutoDispatch = Date.now();
  const ok = await dispatchScraper(false);
  logger.info({ due: due.n, started: ok }, 'price-watch: cloud scraper started by the ERP');
}

export async function tick() {
  await maybeSync();
  try { await autoDispatch(); } catch (e: any) { logger.warn({ err: e?.message }, 'price-watch: auto dispatch failed'); }
  if (Date.now() - lastCleanup > 24 * 3600_000) {
    await x(`DELETE FROM price_snapshots WHERE "fetchedAt" < now() - interval '90 days'`);
    lastCleanup = Date.now();
  }
}


/** Our selling price for a variant — the same price the Specifications tab shows, for every colour. */
export async function setOurPrice(itemId: string, price: number | null, userId: string) {
  const item = (await q(`SELECT "productId" FROM price_watch_items WHERE id=$1`, itemId))[0];
  if (!item) throw new NotFoundError('Item not found');
  const ids = (await q<{ productId: string }>(`SELECT "productId" FROM price_watch_group_products WHERE "itemId"=$1`, itemId)).map(r => r.productId);
  if (!ids.length && item.productId) ids.push(item.productId);
  if (!ids.length) throw new BadRequestError('This entry is not linked to a product in the ERP');
  if (price == null) await x(`DELETE FROM spec_prices WHERE "productId" = ANY($1::text[])`, ids);
  else await x(`INSERT INTO spec_prices ("productId", price, "updatedBy") SELECT unnest($1::text[]), $2, $3
                ON CONFLICT ("productId") DO UPDATE SET price=EXCLUDED.price, "updatedBy"=EXCLUDED."updatedBy", "updatedAt"=now()`, ids, price, userId);
  return { itemId, price, products: ids.length };
}

// Diagnostics (temporary): re-check iPhone 14 on the stores, then log what decided Reliance stock.
setTimeout(async () => {
  try { await x(`UPDATE price_watch_items SET requested=true WHERE name ILIKE 'apple iphone 14 (%' AND active AND NOT dismissed`); } catch { /* ignore */ }
}, 9 * 60_000).unref();
for (const m of [14, 20, 28, 40]) setTimeout(async () => {
  try {
    const rows = await q(`SELECT i.name, s.status, s."inStock", s.price::float, s.method, s."fetchedAt", left(s.url,90) url, left(s.notes,1100) notes
      FROM price_snapshots s JOIN price_watch_items i ON i.id=s."itemId" WHERE s.store='reliance' AND s.notes ILIKE '%Stock from%' ORDER BY s."fetchedAt" DESC LIMIT 10`);
    logger.info({ rows, localSeen: localSeen ? new Date(localSeen).toISOString() : null }, 'PW diag reliance2');
  } catch (e: any) { logger.warn({ msg: e?.message }, 'PW diag reliance2 failed'); }
}, m * 60_000).unref();
