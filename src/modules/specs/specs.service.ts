import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { builtInTemplate, GENERIC, SpecField } from './specs.templates';
import { findPhonePage, readPhone, isGsmArena } from './specs.gsmarena';
import { aiProvider, askForSpecs, askPlain, getPage } from './specs.ai';

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

function finish(specs: Record<string, string>, sources: string[], fields: SpecField[], found = true): FetchResult {
  const clean: Record<string, string> = {};
  for (const f of fields) {
    const v = specs?.[f.key];
    if (v != null && String(v).trim() && !/^(n\/?a|unknown|-|—|not specified)$/i.test(String(v).trim())) clean[f.key] = String(v).trim().slice(0, 240);
  }
  const src = sources.filter(u => /^https?:\/\//.test(String(u))).slice(0, 5);
  const ok = found && Object.keys(clean).length >= Math.min(3, fields.length);
  return { status: ok ? 'OK' : 'NOT_FOUND', specs: clean, sources: src };
}

async function viaAi(title: string, categoryName: string, fields: SpecField[], opts: { site?: string; pageText?: string; pageUrl?: string; note?: string }): Promise<FetchResult> {
  if (!aiProvider()) throw new NoAiError('AI not set up');
  const { text, sources } = await askForSpecs(specPrompt(title, categoryName, fields, opts.note ?? ''), {
    search: !opts.pageText, query: title, site: opts.site, pageText: opts.pageText, pageUrl: opts.pageUrl,
  });
  const j = parseJson(text);
  if (!j) throw new Error('Could not read the specifications from the AI reply');
  const src = [...(Array.isArray(j.sources) ? j.sources : []), ...sources];
  return finish(j.specs ?? {}, src, fields, j.found !== false);
}

async function fetchSpecs(title: string, brand: string, categoryName: string, fields: SpecField[], url?: string | null): Promise<FetchResult> {
  // 1. A link the user gave.
  if (url) {
    if (isGsmArena(url) && isPhoneLike(fields)) {
      try {
        const r = await readPhone(url, title);
        return finish(r.specs, [url], fields);
      } catch (e) {
        if (!aiProvider()) throw new NoAiError('GSMArena unreachable');
        return viaAi(title, categoryName, fields, { note: `Use the GSMArena page ${url} for this model.` });
      }
    }
    const page = await getPage(url);
    if (page.length > 500) return viaAi(title, categoryName, fields, { pageText: page, pageUrl: url });
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    return viaAi(title, categoryName, fields, { site: host || undefined, note: `The specifications are on ${url}.` });
  }
  // 2. Phones & tablets: GSMArena.
  if (isPhoneLike(fields)) {
    let gsmError: any = null;
    try {
      const page = await findPhonePage(title, brand);
      if (page) {
        const r = await readPhone(page, title);
        const res = finish(r.specs, [page], fields);
        if (res.status === 'OK') return res;
      }
    } catch (e) { gsmError = e; }
    if (!aiProvider()) {
      // GSMArena blocked / unreachable and no AI to fall back on.
      if (gsmError) throw new NoAiError(String(gsmError?.message || 'GSMArena unreachable'));
      return { status: 'NOT_FOUND', specs: {}, sources: [] };
    }
    // GSMArena didn't work: same sources through Google Search instead.
    return viaAi(title, categoryName, fields, { note: 'GSMArena is the preferred source for this phone/tablet; the official brand website is equally good.' });
  }
  // 3. Everything else (and phones GSMArena doesn't have): Gemini with web search.
  return viaAi(title, categoryName, fields, {});
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
  const rows: any[] = await (prisma as any).$queryRawUnsafe(`
    SELECT c.id, c.name, COUNT(DISTINCT p.id) AS count
    FROM products p
    JOIN product_categories c ON c.id = p."categoryId"
    WHERE p."isDeleted" = false
      AND EXISTS (SELECT 1 FROM stock_levels s WHERE s."productId" = p.id AND s.quantity > 0)
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
      qty: p.stockLevels.reduce((n: number, s: any) => n + s.quantity, 0),
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

// Self-test once per deploy: fetch one known phone end-to-end (not saved) and log the outcome.
setTimeout(async () => {
  const commit = process.env.RENDER_GIT_COMMIT || 'local';
  try {
    const seen: any[] = await (prisma as any).$queryRawUnsafe(`SELECT fields FROM spec_templates WHERE "categoryName" = '__selftest__'`);
    if (seen[0]?.fields?.commit === commit) return;
    await prisma.$executeRawUnsafe(
      `INSERT INTO spec_templates ("categoryName", fields) VALUES ('__selftest__', $1::jsonb)
       ON CONFLICT ("categoryName") DO UPDATE SET fields = EXCLUDED.fields, "updatedAt" = now()`, JSON.stringify({ commit }));
    const t0 = Date.now();
    const r = await fetchSpecs('Samsung Galaxy A07 5G 4/128GB', 'Samsung', 'Smartphone', await templateFor('Smartphone'));
    logger.info({ ms: Date.now() - t0, status: r.status, sources: r.sources, specs: r.specs }, 'Specs self-test');
  } catch (e: any) { logger.warn({ msg: e?.message }, 'Specs self-test failed'); }
}, 40_000).unref();
