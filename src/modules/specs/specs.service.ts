import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { builtInTemplate, GENERIC, SpecField } from './specs.templates';
import { findPhonePage, readPhone, isGsmArena } from './specs.gsmarena';
import { aiProvider, askForSpecs, askPlain, readPage, askWithUrl, groundingAvailable } from './specs.ai';
import * as g360 from './specs.gadgets360';
import { findOnBrandStore, specPairs, pairsToColumns, storeBrands } from './specs.brandstore';

/*
 * Specifications tab.
 *
 * Specs are stored once per model + variant (colour ignored), in spec_entries,
 * and are never fetched again once found. Missing ones are fetched in the
 * background by an in-process queue: opening the tab enqueues whatever in-stock
 * model has no specs yet, and the page polls until they arrive.
 *
 * Smartphones and Tablets are read straight from GSMArena (free). Everything
 * else — and any phone GSMArena doesn't list — is fetched with Google Gemini's
 * free tier using web search. When a model can't be found, the row asks for a
 * website link, and the specs are then read from that page.
 */

export const aiEnabled = () => aiProvider() !== null;
class NoAiError extends Error {}

// ── Keys ──────────────────────────────────────────────────────────────────
const clean = (s: string) => String(s ?? '').replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();

/** "Samsung A07 5G 4/128GB (Black)" → "Samsung A07 5G 4/128GB"; "iPhone 14 (128GB, Midnight)" → "iPhone 14 128GB". */
export function specTitle(brand: string, model: string): string {
  // In every bracket keep anything with a digit (RAM / storage) and drop the colour.
  const m0 = clean(model).replace(/\(([^()]*)\)/g, (_all, inner: string) => {
    const keep = inner.split(/[,|]/).map(x => x.trim()).filter(x => /\d/.test(x));
    return keep.length ? ` ${keep.join(' ')} ` : ' ';
  });
  let m = clean(m0);
  const b = clean(brand);
  if (b && !m.toLowerCase().startsWith(b.toLowerCase())) m = `${b} ${m}`;
  return m;
}
export const specKey = (brand: string, model: string) => specTitle(brand, model).toLowerCase();

// ── Templates ─────────────────────────────────────────────────────────────
export async function templateFor(categoryName: string): Promise<SpecField[]> {
  const built = builtInTemplate(categoryName);
  if (built) return built;
  const rows: any[] = await (prisma as any).$queryRawUnsafe(
    `SELECT fields FROM spec_templates WHERE "categoryName" = $1`, categoryName);
  if (rows[0]?.fields?.length) return rows[0].fields;
  if (!aiEnabled()) return GENERIC;
  try {
    const text = await askPlain(
      `A mobile & electronics retail shop in India prints a specifications sheet for customers. ` +
      `For the product category "${categoryName}", list the 5 to 7 most useful specification columns a customer compares. ` +
      `Reply with JSON only: {"fields":[{"key":"camelCaseKey","label":"Short Label"}]}`);
    const j = parseJson(text);
    const fields: SpecField[] = (j?.fields ?? [])
      .filter((f: any) => f?.key && f?.label)
      .slice(0, 7)
      .map((f: any) => ({ key: String(f.key).replace(/[^A-Za-z0-9]/g, '').slice(0, 30), label: String(f.label).slice(0, 40) }));
    if (fields.length >= 3) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO spec_templates ("categoryName", fields) VALUES ($1, $2::jsonb)
         ON CONFLICT ("categoryName") DO UPDATE SET fields = EXCLUDED.fields, "updatedAt" = now()`,
        categoryName, JSON.stringify(fields));
      return fields;
    }
  } catch (e: any) { logger.warn({ msg: e?.message }, 'spec template suggestion failed'); }
  return GENERIC;
}

function parseJson(text: string): any {
  const s = text.replace(/```json|```/g, '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function specPrompt(title: string, categoryName: string, fields: SpecField[], extra: string): string {
  const shape = Object.fromEntries(fields.map(f => [f.key, `${f.label} — short, customer-friendly`]));
  return [
    `Find the official specifications of this product sold in India: "${title}" (category: ${categoryName}).`,
    extra,
    `Use only authentic sources: the manufacturer's official website first, then GSMArena, 91mobiles, Smartprix,`,
    `or the official Amazon.in / Flipkart listing. Match the exact model and the RAM/storage variant in the name.`,
    `Do not guess. If you cannot confirm the exact model, set "found": false.`,
    `Write each value briefly (one line, the key facts a salesman tells a customer), e.g. display: `,
    `"6.7\\" HD+ LCD, 90Hz", battery: "5000 mAh, 25W fast charging", os: "Android 15, One UI 7 — 6 OS updates".`,
    `For phones, "os" must include how many years / versions of OS & security updates the brand promises, if published.`,
    `For "expandable" give e.g. "Yes, microSD up to 1TB (hybrid slot)" or "No".`,
    `Reply with JSON only, no other text:`,
    JSON.stringify({ found: true, specs: shape, sources: ['https://...'] }),
  ].join('\n');
}

type FetchResult = { status: 'OK' | 'NOT_FOUND'; specs: Record<string, string>; sources: string[] };

const isPhoneLike = (fields: SpecField[]) => fields.some(f => f.key === 'processor');
/** Marks specs that came from the AI's own knowledge (no web page) — shown as "verify" on the sheet. */
export const AI_KNOWLEDGE = 'ai:knowledge';

async function fromKnowledge(title: string, categoryName: string, fields: SpecField[]): Promise<FetchResult | null> {
  const shape = Object.fromEntries(fields.map(f => [f.key, `${f.label} — short`]));
  const text = await askPlain([
    `From your own knowledge, give the official specifications of this product sold in India: "${title}" (category: ${categoryName}).`,
    `Only answer if you are confident you know this exact model (and variant). If you are not sure, or it may be a model you do not know, reply {"found": false}.`,
    `Never guess a number. Leave out any field you are not sure about.`,
    `Write each value briefly, one line, the facts a salesman tells a customer.`,
    `Reply with JSON only: ${JSON.stringify({ found: true, specs: shape })}`,
  ].join('\n'));
  const j = parseJson(text);
  if (!j || j.found === false) return null;
  const r = finish(j.specs ?? {}, [AI_KNOWLEDGE], fields);
  return r.status === 'OK' ? r : null;
}

function finish(specs: Record<string, string>, sources: string[], fields: SpecField[], found = true): FetchResult {
  const clean: Record<string, string> = {};
  for (const f of fields) {
    const v = specs?.[f.key];
    if (v != null && String(v).trim() && !/^(n\/?a|unknown|-|—|not specified)$/i.test(String(v).trim())) clean[f.key] = String(v).trim().slice(0, 240);
  }
  const src = sources.filter(u => /^https?:\/\//.test(String(u)) || String(u) === AI_KNOWLEDGE).slice(0, 5);
  const ok = found && Object.keys(clean).length >= Math.min(3, fields.length);
  return { status: ok ? 'OK' : 'NOT_FOUND', specs: clean, sources: src };
}

async function viaAi(title: string, categoryName: string, fields: SpecField[],
                     opts: { site?: string; pageText?: string; pageUrl?: string; note?: string; queries?: string[] }): Promise<FetchResult> {
  if (!aiProvider()) throw new NoAiError('AI not set up');
  const { text, sources } = await askForSpecs(specPrompt(title, categoryName, fields, opts.note ?? ''), {
    search: !opts.pageText, query: title, site: opts.site, pageText: opts.pageText, pageUrl: opts.pageUrl, queries: opts.queries,
  });
  return fromAiText(text, sources, fields);
}

function fromAiText(text: string, sources: string[], fields: SpecField[]): FetchResult {
  const j = parseJson(text);
  if (!j) throw new Error('Could not read the specifications from the AI reply');
  const src = [...(Array.isArray(j.sources) ? j.sources : []), ...sources];
  return finish(j.specs ?? {}, [...new Set(src)], fields, j.found !== false);
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function fromGadgets360(url: string, title: string, categoryName: string, fields: SpecField[]): Promise<FetchResult | null> {
  const r = await g360.readProduct(url, title, fields.map(f => f.key));
  const res = finish(r.specs, [url], fields);
  if (res.status === 'OK') return res;
  // Page found but our label mapping came up short: let the AI read the same page (one request).
  if (aiProvider() && r.text.length > 1500) {
    try { return await viaAi(title, categoryName, fields, { pageText: r.text, pageUrl: url }); } catch (e: any) { logger.warn({ msg: e?.message }, 'AI read of Gadgets 360 page failed'); }
  }
  return Object.keys(res.specs).length ? res : null;
}

async function fromBrandSite(title: string, brand: string, categoryName: string, fields: SpecField[]): Promise<FetchResult | null> {
  // The brand's own website (official product page). Spec rows are read directly;
  // the AI only tidies up when the page is too loosely written.
  try {
    const page = await findOnBrandStore(brand, title);
    if (page) {
      const direct = finish(pairsToColumns(specPairs(page.html, page.text), fields.map(f => f.key)), [page.url], fields);
      const enough = Object.keys(direct.specs).length >= Math.max(3, Math.ceil(fields.length * 0.6));
      if (direct.status === 'OK' && (enough || !aiProvider())) return direct;
      if (aiProvider()) {
        const r = await viaAi(title, categoryName, fields, { pageText: page.text, pageUrl: page.url });
        if (r.status === 'OK') return r;
      }
      if (direct.status === 'OK') return direct;
    }
  } catch (e: any) {
    if (/daily limit/i.test(String(e?.message))) throw e;
    logger.warn({ msg: e?.message, title }, 'brand store lookup failed');
  }
  return null;
}

async function fetchSpecs(title: string, brand: string, categoryName: string, fields: SpecField[], url?: string | null): Promise<FetchResult> {
  // 1. A link the user gave: read that page, whichever way works.
  if (url) {
    if (/gadgets360\.com/i.test(url)) {
      const r = await fromGadgets360(url, title, categoryName, fields);
      if (r) return r;
    }
    if (isGsmArena(url) && isPhoneLike(fields)) {
      try { const r = await readPhone(url, title); const res = finish(r.specs, [url], fields); if (res.status === 'OK') return res; } catch { /* blocked */ }
    }
    const page = await readPage(url);                                 // direct, then the free Jina reader
    if (!aiProvider()) throw new NoAiError('AI not set up');
    if (page.length > 1500) return viaAi(title, categoryName, fields, { pageText: page, pageUrl: url });
    const prompt = specPrompt(title, categoryName, fields, `Use the page ${url} for this model.`);
    const viaGoogle = await askWithUrl(prompt, url);                 // Google fetches the page itself
    if (viaGoogle) return fromAiText(viaGoogle, [url], fields);
    throw new Error('That website does not allow the server to read it. Try a Gadgets 360 or the brand\'s own page for this model.');
  }

  // 2a. Accessories, audio, watches: the brand's own website comes first — most authentic, no AI needed.
  if (!isPhoneLike(fields)) { const r = await fromBrandSite(title, brand, categoryName, fields); if (r) return r; }

  // 2. Gadgets 360 — free, no AI, readable from the server. Phones, tablets, watches and more.
  try {
    const page = await g360.findProduct(title, brand);
    if (page) {
      const r = await fromGadgets360(page, title, categoryName, fields);
      if (r && r.status === 'OK') return r;
    }
  } catch (e: any) { logger.warn({ msg: e?.message, title }, 'Gadgets 360 lookup failed'); }

  // 2b. Phones: the brand's own website as well, after Gadgets 360.
  if (isPhoneLike(fields)) { const r = await fromBrandSite(title, brand, categoryName, fields); if (r) return r; }

  // 3. GSMArena directly, when it lets us in (paused for hours after a block).
  if (isPhoneLike(fields)) {
    try {
      const page = await findPhonePage(title, brand);
      if (page) { const r = await readPhone(page, title); const res = finish(r.specs, [page], fields); if (res.status === 'OK') return res; }
    } catch { /* blocked */ }
  }

  // 4. AI with Google Search, only if the key has it (paid keys). Free keys: ask for a link.
  if (aiProvider() && groundingAvailable()) {
    try { return await viaAi(title, categoryName, fields, { note: 'GSMArena, Gadgets 360 or the official brand website are preferred.' }); }
    catch (e: any) { logger.info({ msg: e?.message }, 'search-based fetch unavailable'); }
  }
  // 5. Last resort: the AI's own knowledge, only when it is confident — flagged "verify" on the sheet.
  if (aiProvider()) {
    const r = await fromKnowledge(title, categoryName, fields);
    if (r) return r;
  }
  return { status: 'NOT_FOUND', specs: {}, sources: [] };
}

// ── Queue ─────────────────────────────────────────────────────────────────
type Job = { key: string; title: string; brand: string; categoryName: string; url?: string | null };
const queue: Job[] = [];
const running = new Set<string>();
const CONCURRENCY = 1;   // GSMArena and the free AI tier both dislike bursts

export async function enqueue(jobs: Job[]) {
  for (const j of jobs) {
    if (running.has(j.key) || queue.some(q => q.key === j.key)) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO spec_entries (key, title, brand, "categoryName", status, "sourceUrl")
       VALUES ($1, $2, $3, $4, 'PENDING', $5)
       ON CONFLICT (key) DO UPDATE SET status = 'PENDING', error = NULL,
         "sourceUrl" = COALESCE(EXCLUDED."sourceUrl", spec_entries."sourceUrl"), "updatedAt" = now()`,
      j.key, j.title, j.brand, j.categoryName, j.url ?? null);
    queue.push(j);
  }
  pump();
}

function pump() {
  while (running.size < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running.add(job.key);
    void runJob(job).finally(() => { running.delete(job.key); pump(); });
  }
}

async function runJob(job: Job) {
  await prisma.$executeRawUnsafe(`UPDATE spec_entries SET status = 'FETCHING', "updatedAt" = now() WHERE key = $1`, job.key);
  try {
    const fields = await templateFor(job.categoryName);
    const r = await fetchSpecs(job.title, job.brand, job.categoryName, fields, job.url);
    await prisma.$executeRawUnsafe(
      `UPDATE spec_entries SET status = $2, specs = $3::jsonb, sources = $4::jsonb, error = $5,
         manual = false, "fetchedAt" = now(), "updatedAt" = now() WHERE key = $1`,
      job.key, r.status, JSON.stringify(r.specs), JSON.stringify(r.sources),
      r.status === 'NOT_FOUND' ? 'Exact specifications could not be confirmed online.' : null);
    logger.info({ key: job.key, status: r.status, filled: Object.keys(r.specs).length, sources: r.sources.slice(0, 2), link: !!job.url }, 'spec fetched');
  } catch (e: any) {
    if (e instanceof NoAiError) {
      await prisma.$executeRawUnsafe(`UPDATE spec_entries SET status = 'NO_AI', error = $2, "updatedAt" = now() WHERE key = $1`,
        job.key, 'Automatic fetching needs the free Gemini key on the server.');
      return;
    }
    logger.warn({ key: job.key, msg: e?.message }, 'spec fetch failed');
    await prisma.$executeRawUnsafe(`UPDATE spec_entries SET status = 'ERROR', error = $2, "updatedAt" = now() WHERE key = $1`,
      job.key, String(e?.message || 'Fetch failed').slice(0, 300));
  }
}

// ── Data for the tab ──────────────────────────────────────────────────────
export async function inStockCategories() {
  // Same sellable rule as the sheet: IMEI-tracked products count only regular
  // in-stock units; others use the stock level.
  const rows: any[] = await (prisma as any).$queryRawUnsafe(`
    WITH lvl AS (
      SELECT "productId", SUM(quantity) AS qty FROM stock_levels GROUP BY "productId"
    ), units AS (
      SELECT "productId",
        COUNT(*) FILTER (WHERE "imeiType" = 'NIL' AND status = 'IN_STOCK') AS sellable,
        COUNT(*) FILTER (WHERE ("imeiType" IN ('DEMO','OPEN_BOX') OR status IN ('DEMO','OPEN_BOX')) AND status != 'SOLD') AS other
      FROM imei_inventory WHERE "isDeleted" = false GROUP BY "productId"
    )
    SELECT c.id, c.name, COUNT(DISTINCT p.id) AS count
    FROM products p
    JOIN product_categories c ON c.id = p."categoryId"
    JOIN lvl ON lvl."productId" = p.id
    LEFT JOIN units u ON u."productId" = p.id
    WHERE p."isDeleted" = false
      AND (CASE WHEN u."productId" IS NOT NULL AND (u.sellable > 0 OR u.other > 0) THEN u.sellable ELSE lvl.qty END) > 0
    GROUP BY c.id, c.name ORDER BY c.name`);
  return rows.map((r: any) => ({ id: r.id, name: r.name, count: Number(r.count) }));
}

export async function sheet(categoryId: string) {
  const cat = await prisma.productCategory.findUnique({ where: { id: categoryId }, select: { id: true, name: true } });
  if (!cat) return null;
  const products: any[] = await prisma.product.findMany({
    where: { isDeleted: false, categoryId, stockLevels: { some: { quantity: { gt: 0 } } } },
    select: { id: true, ean: true, model: true, brand: true, costPrice: true, sellingPrice: true,
              stockLevels: { select: { quantity: true } } },
  });
  // Sellable stock, counted exactly like the Stock Report: when a product has
  // IMEI / serial units, only regular (NIL) units that are IN_STOCK count —
  // demo and open-box units don't. Otherwise the stock level is the count.
  const unitCounts: any[] = products.length ? await (prisma as any).$queryRawUnsafe(`
    SELECT "productId",
      COUNT(*) FILTER (WHERE "imeiType" = 'NIL' AND status = 'IN_STOCK') AS sellable,
      COUNT(*) FILTER (WHERE "imeiType" = 'NIL' AND status = 'IN_STOCK' AND activated = true) AS activated,
      COUNT(*) FILTER (WHERE ("imeiType" = 'DEMO' OR status = 'DEMO') AND status != 'SOLD') AS demo,
      COUNT(*) FILTER (WHERE ("imeiType" = 'OPEN_BOX' OR status = 'OPEN_BOX') AND status != 'SOLD') AS "openBox"
    FROM imei_inventory
    WHERE "isDeleted" = false AND "productId" = ANY($1::text[])
    GROUP BY "productId"`, products.map((p: any) => p.id)) : [];
  const unitsBy = new Map<string, any>(unitCounts.map((u: any) => [u.productId, u]));
  const available = (p: any) => {
    const u = unitsBy.get(p.id);
    const level = p.stockLevels.reduce((n: number, s: any) => n + s.quantity, 0);
    if (u && (Number(u.sellable) > 0 || Number(u.demo) > 0 || Number(u.openBox) > 0)) {
      return { qty: Number(u.sellable), activated: Number(u.activated) };
    }
    return { qty: level, activated: 0 };
  };
  // Only what can actually be sold today.
  for (let i = products.length - 1; i >= 0; i--) if (available(products[i]).qty <= 0) products.splice(i, 1);

  const fields = await templateFor(cat.name);
  const keys = [...new Set(products.map((p: any) => specKey(p.brand, p.model)))];
  const entries = keys.length ? await (prisma as any).$queryRawUnsafe(
    `SELECT key, title, status, specs, sources, error, "sourceUrl", manual, "fetchedAt", "updatedAt"
     FROM spec_entries WHERE key = ANY($1::text[])`, keys) : [];
  const byKey = new Map<string, any>((entries as any[]).map((e: any) => [e.key, e]));
  const prices = products.length ? await (prisma as any).$queryRawUnsafe(
    `SELECT "productId", price FROM spec_prices WHERE "productId" = ANY($1::text[])`, products.map((p: any) => p.id)) : [];
  const priceBy = new Map<string, number>((prices as any[]).map((p: any) => [p.productId, Number(p.price)]));

  // Fetch whatever is missing, plus jobs left half-done by a restart.
  const stale = Date.now() - 5 * 60_000;
  const toFetch: Job[] = [];
  for (const p of products) {
    const key = specKey(p.brand, p.model);
    const e = byKey.get(key);
    const stuck = e && (e.status === 'PENDING' || e.status === 'FETCHING') && new Date(e.updatedAt).getTime() < stale && !running.has(key);
    const noAiNowEnabled = e?.status === 'NO_AI' && aiEnabled();
    // A failed fetch (network / AI hiccup) is retried after an hour; "not found" waits for a link.
    const retryError = e?.status === 'ERROR' && new Date(e.updatedAt).getTime() < Date.now() - 60 * 60_000 && !running.has(key);
    if ((!e || stuck || noAiNowEnabled || retryError) && !toFetch.some(j => j.key === key)) {
      toFetch.push({ key, title: specTitle(p.brand, p.model), brand: p.brand, categoryName: cat.name, url: e?.sourceUrl ?? null });
    }
  }
  if (toFetch.length) await enqueue(toFetch);

  const rows = products.map((p: any) => {
    const key = specKey(p.brand, p.model);
    const e = byKey.get(key) ?? (toFetch.some(j => j.key === key) ? { status: 'PENDING' } : null);
    const cost = Number(p.costPrice);
    return {
      productId: p.id, ean: p.ean, brand: p.brand, model: p.model, key,
      qty: available(p).qty, activated: available(p).activated,
      price: priceBy.get(p.id) ?? cost, priceEdited: priceBy.has(p.id), costPrice: cost, mrp: Number(p.sellingPrice),
      status: e?.status ?? 'PENDING', specs: e?.specs ?? {}, sources: e?.sources ?? [],
      error: e?.error ?? null, sourceUrl: e?.sourceUrl ?? null, manual: !!e?.manual,
    };
  });
  // Brands A→Z, then price low → high, then name.
  rows.sort((a: any, b: any) => a.brand.localeCompare(b.brand) || a.price - b.price || a.model.localeCompare(b.model));
  return { category: cat, fields, rows, aiEnabled: aiEnabled() };
}

export async function setPrice(productId: string, price: number | null, userId: string) {
  if (price == null) {
    await prisma.$executeRawUnsafe(`DELETE FROM spec_prices WHERE "productId" = $1`, productId);
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO spec_prices ("productId", price, "updatedBy") VALUES ($1, $2, $3)
       ON CONFLICT ("productId") DO UPDATE SET price = EXCLUDED.price, "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()`,
      productId, price, userId);
  }
}

export async function setSpecs(key: string, specs: Record<string, string>, userId: string) {
  const r = await prisma.$executeRawUnsafe(
    `UPDATE spec_entries SET specs = $2::jsonb, status = 'OK', manual = true, error = NULL,
       "updatedAt" = now(), "updatedBy" = $3 WHERE key = $1`, key, JSON.stringify(specs), userId);
  return r > 0;
}

export async function refetch(key: string, url: string | null) {
  const rows: any[] = await (prisma as any).$queryRawUnsafe(`SELECT key, title, brand, "categoryName" FROM spec_entries WHERE key = $1`, key);
  const e = rows[0];
  if (!e) return false;
  await enqueue([{ key, title: e.title, brand: e.brand, categoryName: e.categoryName, url }]);
  return true;
}

// Once per deploy: give earlier failures another go with the current engine.
setTimeout(async () => {
  const commit = process.env.RENDER_GIT_COMMIT || 'local';
  try {
    const seen: any[] = await (prisma as any).$queryRawUnsafe(`SELECT fields FROM spec_templates WHERE "categoryName" = '__selftest__'`);
    if (seen[0]?.fields?.commit === commit) return;
    await prisma.$executeRawUnsafe(
      `INSERT INTO spec_templates ("categoryName", fields) VALUES ('__selftest__', $1::jsonb)
       ON CONFLICT ("categoryName") DO UPDATE SET fields = EXCLUDED.fields, "updatedAt" = now()`, JSON.stringify({ commit }));
    const n = await prisma.$executeRawUnsafe(
      `UPDATE spec_entries SET status = 'PENDING', error = NULL, "updatedAt" = now() - interval '1 hour'
       WHERE manual = false AND (status IN ('ERROR', 'NOT_FOUND', 'NO_AI')
          OR (status = 'OK' AND sources::text ILIKE '%gadgets360%')
          OR (status = 'OK' AND sources::text ILIKE '%ai:knowledge%' AND lower(brand) = ANY($1::text[])))`, storeBrands());   // Gadgets 360 rows: re-read with the latest parser (no AI cost)
    logger.info({ requeued: n }, 'Specs: earlier failures queued for another try');
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT key, title, brand, "categoryName", "sourceUrl" FROM spec_entries WHERE status = 'PENDING' ORDER BY "updatedAt" LIMIT 300`);
    await enqueue(rows.map(r => ({ key: r.key, title: r.title, brand: r.brand, categoryName: r.categoryName, url: r.sourceUrl })));
  } catch (e: any) { logger.warn({ msg: e?.message }, 'Specs requeue failed'); }
}, 30_000).unref();

// Every hour, retry fetches that failed (e.g. the free AI daily limit) so the
// sheet keeps filling without anyone opening the tab.
setInterval(async () => {
  try {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT key, title, brand, "categoryName", "sourceUrl" FROM spec_entries
       WHERE status = 'ERROR' AND manual = false AND "updatedAt" < now() - interval '1 hour' ORDER BY "updatedAt" LIMIT 100`);
    if (rows.length) await enqueue(rows.map(r => ({ key: r.key, title: r.title, brand: r.brand, categoryName: r.categoryName, url: r.sourceUrl })));
  } catch (e: any) { logger.warn({ msg: e?.message }, 'specs hourly retry failed'); }
}, 60 * 60_000).unref();

// Diagnostics (temporary, read-only): every product whose serials/IMEIs and stock count disagree.
setTimeout(async () => {
  try {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(`
      WITH l AS (SELECT "productId", SUM(quantity)::int AS ledger FROM inventory_transactions GROUP BY 1),
           s AS (SELECT "productId", SUM(quantity)::int AS level FROM stock_levels GROUP BY 1),
           u AS (SELECT "productId", COUNT(*) FILTER (WHERE status = 'IN_STOCK')::int AS units, COUNT(*)::int AS anyunits
                 FROM imei_inventory WHERE "isDeleted" = false GROUP BY 1)
      SELECT p.model, p.brand, COALESCE(s.level,0) AS level, COALESCE(l.ledger,0) AS ledger, COALESCE(u.units,0) AS units
      FROM products p JOIN u ON u."productId" = p.id
      LEFT JOIN s ON s."productId" = p.id LEFT JOIN l ON l."productId" = p.id
      WHERE p."isDeleted" = false AND (COALESCE(u.units,0) <> COALESCE(s.level,0) OR COALESCE(l.ledger,0) <> COALESCE(s.level,0))
      ORDER BY p.brand, p.model`);
    for (let i = 0; i < rows.length; i += 25) logger.info({ total: rows.length, part: i / 25, rows: rows.slice(i, i + 25) }, 'Serial mismatch list');
  } catch (e: any) { logger.warn({ msg: e?.message }, 'Serial mismatch list failed'); }
}, 25_000).unref();
