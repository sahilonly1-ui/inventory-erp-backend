// iTechArena price scraper — reads live prices and bank offers from Amazon,
// Flipkart, Croma, Reliance Digital and brand sites and posts them to the ERP.
// Runs on GitHub Actions (.github/workflows/price-scraper.yml) or any PC:
//
//   cd scraper && npm install && npx playwright install chromium
//   set AGENT_KEY=...   (same value as PRICE_AGENT_KEY on Render)
//   node index.mjs
//
// Env: AGENT_KEY (required) · API_BASE · LIMIT (products per run, default 100)
//      QUEUED_ONLY=1 (only products queued with "Check prices") · STORES=amazon,flipkart
//      HEADLESS=0 (watch it work) · CHROME_PATH (custom Chromium) · DEBUG_DIR (default ./debug)

import fs from 'node:fs';
import path from 'node:path';
import { isProductUrl, urlKey, pickBest, titleScore, extractOffers, searchQueries, storeSearchUrl } from './lib.mjs';

const API = process.env.API_BASE || 'https://inventory-erp-backend-iplr.onrender.com/api/v1';
const KEY = process.env.AGENT_KEY;
const LIMIT = Number(process.env.LIMIT || 100);
const ONLY = (process.env.STORES || '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG = process.env.DEBUG_DIR || path.resolve('debug');
const ITEM_CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (!KEY && !process.env.SCRAPER_TEST) { console.error('AGENT_KEY is not set'); process.exit(1); }
fs.mkdirSync(DEBUG, { recursive: true });

// ── ERP API ────────────────────────────────────────────────────────────────
async function api(pathname, init = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(API + pathname, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-agent-key': KEY, ...(init.headers || {}) },
        signal: AbortSignal.timeout(90_000), // Render free tier can take ~50s to wake
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${r.status} ${j?.error?.message || r.statusText}`);
      return j.data;
    } catch (e) {
      if (i >= tries || /^4\d\d /.test(e.message)) throw e;
      console.log(`  API retry ${i} (${e.message})`);
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
}

// ── Browser ────────────────────────────────────────────────────────────────
async function launch() {
  let pw;
  try { pw = await import('playwright'); } catch { pw = await import('playwright-core'); }
  const browser = await pw.chromium.launch({
    headless: process.env.HEADLESS !== '0',
    executablePath: process.env.CHROME_PATH || undefined,
    // Full Chromium in new-headless mode looks like a normal browser to stores;
    // the slimmer "headless shell" is easier for bot checks to spot.
    channel: process.env.CHROME_PATH ? undefined : (process.env.CHANNEL || 'chromium'),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: UA, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  // Images, fonts and video are not needed to read a price — skipping them roughly halves load time.
  await context.route('**/*', route => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  return { browser, context };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);

async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.keyboard.press('Escape').catch(() => {}); // Flipkart's login popup
  // Wait for a rupee amount to render (Croma / Reliance draw prices with JS).
  await page.waitForFunction(() => /₹\s?\d/.test(document.body?.innerText || ''), null, { timeout: 15_000 }).catch(() => {});
  await sleep(1200);
}

async function isBlocked(page) {
  const t = (await page.title().catch(() => '')).toLowerCase();
  const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '')).toLowerCase();
  if (t.includes('robot check') || body.includes('enter the characters you see below')) return 'captcha';
  if (body.includes('access denied') || t.includes('access denied') || body.includes('are you a human')) return 'access denied';
  if (body.length < 200) return 'empty page';
  return null;
}

async function debugDump(page, name) {
  try {
    await page.screenshot({ path: path.join(DEBUG, `${name}.png`), fullPage: false });
    fs.writeFileSync(path.join(DEBUG, `${name}.html`), await page.content());
  } catch { /* best effort */ }
}

// Amazon sometimes answers a new browser with a one-button "Continue shopping"
// page before the real one. Pressing it sets a cookie and lets us through.
async function passInterstitial(page, url) {
  const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)).catch(() => '');
  if (!/continue shopping|click the button below to continue/i.test(body) || body.length > 1500) return false;
  const btn = page.locator('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[type="submit"]').first();
  if (await btn.count()) {
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), btn.click({ timeout: 5000 }).catch(() => {})]);
    await sleep(1500);
  }
  await open(page, url);
  return true;
}

async function pageSnippet(page) {
  const title = await page.title().catch(() => '');
  const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)).catch(() => '');
  return `title "${title.slice(0, 70)}" · text "${text}"`;
}

// What happened on each store, written to the GitHub run page (public) so
// failures can be diagnosed without logs.
const diag = [];

// ── Finding the product on a search page ───────────────────────────────────
async function findOnSearch(page, store, job, officialSite) {
  const links = await page.evaluate(() => {
    const out = [];
    // Amazon result cards carry the product code directly — works whatever the link format.
    for (const c of document.querySelectorAll('[data-asin]')) {
      const asin = c.getAttribute('data-asin');
      if (!/^[A-Z0-9]{10}$/.test(asin || '')) continue;
      const t = c.querySelector('h2')?.closest('a')?.innerText || [...c.querySelectorAll('h2')].map(h => h.innerText).join(' ') || '';
      out.push({ href: `https://www.amazon.in/dp/${asin}`, text: t.trim().slice(0, 300) });
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const card = a.closest('[data-component-type="s-search-result"], [data-id], li, article') || a.parentElement;
      const heading = card?.querySelector('h2, h3, [title]');
      const text = [a.getAttribute('title'), a.getAttribute('aria-label'), a.innerText, heading?.textContent, heading?.getAttribute?.('title')]
        .filter(Boolean).map(s => s.trim()).sort((x, y) => y.length - x.length)[0] || '';
      out.push({ href: a.href, text: text.slice(0, 300) });
    }
    return out;
  });
  const byKey = new Map();
  for (const l of links) {
    if (!isProductUrl(store, l.href)) continue;
    if (store === 'official') {
      try { const h = new URL(l.href).hostname; if (!(h === officialSite || h.endsWith('.' + officialSite) || officialSite.endsWith(h.replace(/^www\./, '')))) continue; } catch { continue; }
    }
    const k = urlKey(store, l.href);
    const prev = byKey.get(k);
    if (!prev || l.text.length > prev.text.length) byKey.set(k, l);
  }
  const name = [job.name, job.variant].filter(Boolean).join(' ');
  const cands = [...byKey.values()];
  const hit = pickBest(name, job.brand, cands);
  const top = cands.map(c => ({ text: c.text, score: titleScore(name, job.brand, c.text) })).sort((a, b) => b.score - a.score)[0];
  return { hit, count: cands.length, top };
}

// ── Reading a product page ─────────────────────────────────────────────────
async function expandOffers(page, store) {
  const tries = store === 'amazon'
    ? ['#itembox-InstantBankDiscount a', '#itembox-InstantBankDiscount', '#vsxoffers_feature_div .a-carousel-card a']
    : [];
  for (const sel of tries) {
    try { const el = page.locator(sel).first(); if (await el.count()) { await el.click({ timeout: 2500 }); await sleep(1500); break; } } catch { /* next */ }
  }
  // "View 5 more offers", "View all offers", "See all", "+3 more offers"
  try {
    const more = page.getByText(/^(\+?\s*\d+\s+more offers?|view (all|\d+ more) offers?|see all offers?|view more offers?)$/i).first();
    if (await more.count()) { await more.click({ timeout: 2500 }); await sleep(1200); }
  } catch { /* fine */ }
}

/** Runs inside the page: title, price, M.R.P., stock, structured data, offer text. */
function readPage(store) {
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const num = s => { const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const res = { title: null, price: null, mrp: null, priceText: null, inStock: null, ldPrice: null, ldName: null, text: '' };

  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      for (const n of (Array.isArray(j) ? j : j['@graph'] || [j])) {
        if (!String(n?.['@type'] || '').toLowerCase().includes('product')) continue;
        const off = Array.isArray(n.offers) ? n.offers[0] : n.offers;
        const p = Number(off?.price ?? off?.lowPrice);
        if (p > 0) { res.ldPrice = p; res.ldName = n.name || null; }
        if (off?.availability) res.inStock = !/OutOfStock|SoldOut|Discontinued/i.test(off.availability);
      }
    } catch { /* ignore */ }
  }

  if (store === 'amazon') {
    res.title = txt(document.querySelector('#productTitle')) || null;
    const box = document.querySelector('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop, #corePrice_desktop');
    const pay = box?.querySelector('.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .a-price .a-offscreen');
    const whole = box?.querySelector('.priceToPay .a-price-whole, .a-price-whole');
    const pt = txt(pay) || (whole ? '₹' + txt(whole) : '');
    if (pt) { res.price = num(pt); res.priceText = pt; }
    const mrpEl = box?.querySelector('.basisPrice .a-offscreen, .a-price.a-text-price .a-offscreen');
    if (mrpEl) res.mrp = num(txt(mrpEl));
    const av = txt(document.querySelector('#availability')).toLowerCase();
    if (av) res.inStock = !/(currently unavailable|out of stock)/.test(av);
  }

  // Generic: the biggest, un-struck rupee amount near the top of the page is
  // the selling price; a struck-through larger one next to it is the M.R.P.
  if (!res.price) {
    const cands = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 2) continue;
      const t = txt(el);
      if (!/^(₹|rs\.?)\s?[\d,]+(\.\d{1,2})?$/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const top = r.top + window.scrollY;
      if (top > 1600) continue;
      const cs = getComputedStyle(el);
      const struck = /line-through/.test(cs.textDecorationLine || cs.textDecoration) || !!el.closest('del, s, strike');
      cands.push({ v: num(t), t, size: parseFloat(cs.fontSize) || 0, top, struck });
    }
    const live = cands.filter(c => !c.struck && c.v > 0).sort((a, b) => b.size - a.size || a.top - b.top);
    if (live[0]) {
      res.price = live[0].v; res.priceText = live[0].t;
      const m = cands.filter(c => c.struck && c.v > res.price).sort((a, b) => Math.abs(a.top - live[0].top) - Math.abs(b.top - live[0].top))[0];
      if (m) res.mrp = m.v;
    }
  }
  if (!res.price && res.ldPrice) { res.price = res.ldPrice; res.priceText = '₹' + res.ldPrice; }

  if (!res.title) res.title = txt(document.querySelector('h1')) || document.title || null;
  const body = (document.body?.innerText || '');
  if (res.inStock === null) {
    const low = body.toLowerCase();
    if (/(out of stock|sold out|currently unavailable|notify me when available)/.test(low)) res.inStock = false;
    else if (/(add to cart|buy now)/.test(low)) res.inStock = true;
  }
  // Text above the recommendation rails holds the offers; keep it bounded.
  const cut = body.search(/(similar products|customers (also|who) (viewed|bought)|frequently bought|you may also like|recommended for you|sponsored products)/i);
  res.text = (cut > 100 ? body.slice(0, cut) : body).slice(0, 60_000);
  return res;
}

async function scrapeStore(context, job, s) {
  const page = await context.newPage();
  const tag = `${s.store}-${slug(job.name)}`;
  try {
    let url = s.url;
    if (!url) {
      if (s.store === 'official' && !s.officialSite) return { store: s.store, status: 'not_found', note: 'No brand site known — paste the product URL in Market Prices' };
      let why = '';
      for (const q of searchQueries(job.name, job.brand, job.variant)) {
        const su = storeSearchUrl(s.store, q, s.officialSite);
        if (!su) break;
        await open(page, su);
        if (s.store === 'amazon') await passInterstitial(page, su);
        const blocked = await isBlocked(page);
        if (blocked) {
          await debugDump(page, tag + '-search');
          diag.push({ store: s.store, product: job.name, what: `search blocked (${blocked})`, detail: await pageSnippet(page) });
          return { store: s.store, status: 'blocked', note: `Search page: ${blocked}` };
        }
        const f = await findOnSearch(page, s.store, job, s.officialSite);
        if (f.hit) { url = f.hit.href; break; }
        why = `query "${q}": ${f.count} product links` + (f.top ? `, best "${f.top.text.slice(0, 60)}" (${f.top.score.toFixed(2)})` : '');
      }
      if (!url) {
        await debugDump(page, tag + '-search');
        diag.push({ store: s.store, product: job.name, what: 'not found in search', detail: `${why} · ${await pageSnippet(page)}` });
        return { store: s.store, status: 'not_listed' };
      }
    }
    await open(page, url);
    if (s.store === 'amazon') await passInterstitial(page, url);
    const blocked = await isBlocked(page);
    if (blocked) {
      await debugDump(page, tag);
      diag.push({ store: s.store, product: job.name, what: `product page blocked (${blocked})`, detail: await pageSnippet(page) });
      return { store: s.store, url, status: 'blocked', note: blocked };
    }
    await expandOffers(page, s.store);
    const r = await page.evaluate(readPage, s.store);
    if (!r.price) {
      await debugDump(page, tag);
      diag.push({ store: s.store, product: job.name, what: 'no price on product page', detail: `${page.url()} · ${await pageSnippet(page)}` });
      return { store: s.store, url: page.url(), status: 'not_found', note: 'Price not found on page' };
    }
    return {
      store: s.store, url: page.url(), status: 'ok', price: r.price, mrp: r.mrp, inStock: r.inStock,
      title: r.title, priceText: r.priceText, offers: extractOffers(r.text),
      note: r.ldPrice && Math.abs(r.ldPrice - r.price) > 1 ? `Structured data says ₹${r.ldPrice}` : null,
    };
  } catch (e) {
    await debugDump(page, tag + '-error');
    diag.push({ store: s.store, product: job.name, what: 'error', detail: String(e.message || e).slice(0, 200) });
    return { store: s.store, url: s.url, status: 'error', note: String(e.message || e).slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const qs = `?limit=${LIMIT}${process.env.QUEUED_ONLY === '1' ? '&queued=1' : ''}`;
  const jobs = await api('/price-watch/bot/jobs' + qs);
  console.log(`${jobs.length} product(s) to check`);
  if (!jobs.length) return;

  const { browser, context } = await launch();
  const stats = { ok: 0, blocked: 0, not_listed: 0, not_found: 0, error: 0 };
  const perStore = {};
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const stores = job.stores.filter(s => !ONLY.length || ONLY.includes(s.store));
      const results = await Promise.all(stores.map(s => scrapeStore(context, job, s)));
      results.forEach(r => {
        stats[r.status] = (stats[r.status] || 0) + 1;
        const ps = (perStore[r.store] ||= {});
        ps[r.status] = (ps[r.status] || 0) + 1;
      });
      const line = results.map(r => `${r.store}:${r.status === 'ok' ? '₹' + r.price + (r.offers?.length ? `+${r.offers.length}off` : '') : r.status}`).join('  ');
      console.log(`• ${job.name}\n    ${line}`);
      try { await api(`/price-watch/bot/results/${job.itemId}`, { method: 'POST', body: JSON.stringify({ results }) }); }
      catch (e) { console.log(`    ! could not save: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, jobs.length) }, worker));
  await browser.close();
  console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s —`, stats);
  report(perStore);
}

/** Per-store results + example failures, as GitHub annotations and a job summary (both public). */
function report(perStore) {
  const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, ' ');
  for (const [store, c] of Object.entries(perStore)) {
    const counts = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ');
    const ex = diag.filter(d => d.store === store).slice(0, 2).map(d => `[${d.product}] ${d.what}: ${d.detail}`).join(' || ');
    console.log(`::notice title=${store}::${esc(counts + (ex ? ' || ' + ex : '')).slice(0, 900)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(perStore).map(([st, c]) => `| ${st} | ${Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(', ')} |`).join('\n');
    const fails = diag.slice(0, 40).map(d => `| ${d.store} | ${d.product} | ${d.what} | ${String(d.detail).replace(/\|/g, '/').slice(0, 300)} |`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Price scraper\n\n| Store | Results |\n|---|---|\n${rows}\n\n### Failures\n\n| Store | Product | What | Detail |\n|---|---|---|---|\n${fails}\n`);
  }
}

export { launch, scrapeStore, readPage };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
