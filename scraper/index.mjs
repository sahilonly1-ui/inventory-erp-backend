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
//      WATCH=1 — stay running (showroom PC): poll the ERP every few seconds and
//                refresh anything queued within seconds; also keeps due items fresh.
//      CHANNEL=chrome — use the Google Chrome already installed on the machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugFilesToDelete, classifyMiss, makeBudget, makeBreaker, isProductUrl, urlKey, pickBest, titleScore, extractOffers, searchQueries, storeSearchUrl, STORE_DOMAIN, MARKETPLACES, unwrapSearchLink, engineUrls, sitemapLocs, slugText, productSitemaps, googleUrl, isGoogleBlock, parseAmazonPanel, parseAmazonCards, parseOffer, wantedMemory, memoryOptionMatches, brandSiteRule, brandUrlOk, brandScore, pickBrandPage as pickBrandPageAll, shopifyPick, memOf, memMatch, vtexPick } from './lib.mjs';

const API = process.env.API_BASE || 'https://inventory-erp-backend-iplr.onrender.com/api/v1';
const KEY = process.env.AGENT_KEY;
const LIMIT = Number(process.env.LIMIT || 300);
const ONLY = (process.env.STORES || '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG = process.env.DEBUG_DIR || path.resolve('debug');
const WATCH = process.env.WATCH === '1';
// On the showroom PC keep it light: 2 products (≈10 tabs) at a time.
// On the showroom PC the scraper shares a laptop with the person using it, so it is
// run light: one product at a time, a few pages at most, no debug screenshots unless
// asked for, and at below-normal priority. GitHub's runner has the machine to itself
// and keeps the old settings. (Images, video and fonts are skipped in both — see launch.)
const ITEM_CONCURRENCY = Number(process.env.CONCURRENCY || (WATCH ? 1 : 6));
const DUMPS = !WATCH || process.env.DEBUG_DUMPS === '1';
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

async function open(page, url, { waitPrice = true } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (!waitPrice) { await sleep(400); return; }
  await page.keyboard.press('Escape').catch(() => {}); // Flipkart's login popup
  // Wait for a rupee amount to render (Croma / Reliance draw prices with JS).
  await page.waitForFunction(() => /₹\s?\d/.test(document.body?.innerText || ''), null, { timeout: 5_000 }).catch(() => {});
  // Amazon streams its 1–2 MB page: a ₹ in the header shows up long before the
  // price block and buy box. On a slow PC the price was read too early.
  if (/amazon\./.test(url)) await amazonSettle(page);
  await sleep(300);
}

const AMAZON_READY = '#corePriceDisplay_desktop_feature_div .a-price-whole, #corePrice_feature_div .a-offscreen, #apex_desktop .a-price-whole, ' +
  '#twister-plus-price-data-price, #outOfStock, #buybox-see-all-buying-choices, #add-to-cart-button, #availability';
async function amazonSettle(page, ms = 20_000) {
  await page.waitForSelector(AMAZON_READY, { state: 'attached', timeout: ms }).catch(() => {});
  await page.waitForLoadState('load', { timeout: ms }).catch(() => {});
}

async function isBlocked(page) {
  const t = (await page.title().catch(() => '')).toLowerCase();
  const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '')).toLowerCase();
  if (t.includes('robot check') || body.includes('enter the characters you see below')) return 'captcha';
  // Amazon's soft blocks for cloud servers: a fake 404 or a "rush hour" 503.
  if (t.includes('page not found') && body.includes('not a functioning page')) return 'soft block (404)';
  if (t.includes('503') || body.includes("it's rush hour")) return 'soft block (503)';
  if (body.includes('access denied') || t.includes('access denied') || body.includes('are you a human')) return 'access denied';
  if (body.length < 200) return 'empty page';
  return null;
}

async function debugDump(page, name) {
  if (!DUMPS) return;   // on the PC only when DEBUG_DUMPS=1 (see ITEM_CONCURRENCY)
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
// Stores that are blocking this run are skipped for a while instead of being tried (and failing) for every product.
const breaker = makeBreaker();

// ── Politeness: at most N pages open per store at once ────────────────────
// Bursts of parallel requests are what get a server blocked. Amazon is the
// strictest, so it gets one page at a time with a short gap.
const STORE_SLOTS = WATCH
  ? { amazon: 1, flipkart: 2, croma: 2, reliance: 2, official: 2, engine: 1, google: 1 }   // a laptop someone is using: at most a few pages at once
  : { amazon: 1, flipkart: 3, croma: 3, reliance: 3, official: 4, engine: 2, google: 1 };
// Google is searched one query at a time with a human-ish pause, which is what
// keeps it from showing its "unusual traffic" page.
const GAP_MS = WATCH ? { amazon: 400, engine: 300, google: 2500 } : { amazon: 1200, engine: 800, google: 4000 };
const slots = {};
async function withSlot(key, fn) {
  const s = (slots[key] ||= { busy: 0, waiters: [] });
  if (s.busy >= (STORE_SLOTS[key] ?? 3)) await new Promise(r => s.waiters.push(r));
  s.busy++;
  try { return await fn(); }
  finally {
    if (GAP_MS[key]) await sleep(GAP_MS[key] + Math.random() * 600);
    s.busy--; s.waiters.shift()?.();
  }
}

// ── Finding the product through Bing / DuckDuckGo ─────────────────────────
// "site:amazon.in JBL PartyBox 130" finds the product page without touching the
// store's own search, which is what stores block first.
async function findViaEngine(_page, store, job, domain) {
  // Its own tab: a store page that is still loading or failed can't interrupt it.
  const page = await _page.context().newPage();
  try { return await engineSearch(page, store, job, domain); }
  finally { await page.close().catch(() => {}); }
}
async function engineSearch(page, store, job, domain) {
  const queries = searchQueries(job.name, job.brand, job.variant);
  const name = [job.name, job.variant].filter(Boolean).join(' ');
  let why = '';
  for (const url of engineUrls(domain, queries[queries.length - 1])) {
    try {
      await withSlot('engine', () => open(page, url, { waitPrice: false }));
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || a.title || '').trim().slice(0, 300) })));
      const byKey = new Map();
      for (const l of links) {
        const href = unwrapSearchLink(l.href);
        if (!isProductUrl(store, href)) continue;
        try { const h = new URL(href).hostname.replace(/^www\./, ''); if (!(h === domain || h.endsWith('.' + domain))) continue; } catch { continue; }
        const k = urlKey(store, href);
        const text = l.text.replace(/\s*[-|:]\s*(amazon\.in|flipkart|croma|reliance digital)[\s\S]*$/i, '');
        const prev = byKey.get(k);
        if (!prev || text.length > prev.text.length) byKey.set(k, { href, text });
      }
      const hit = pickBest(name, job.brand, [...byKey.values()]);
      if (hit) return { hit };
      const host = new URL(url).hostname.replace(/^(www|html|in)\./, '');
      why += `${host}: ${byKey.size} links` + (byKey.size ? '' : ` ("${(await page.title().catch(() => '')).slice(0, 40)}")`) + '; ';
    } catch (e) { why += `${url.slice(8, 30)}: ${e.message.slice(0, 60)}; `; }
  }
  return { hit: null, why };
}

// ── Google: one search per product, links for every store at once ─────────
// Tries the EAN first (exact when a store shows it), then the product name. If
// Google shows its captcha, it is skipped for 30 minutes and the other methods
// (sitemap, store search, Bing/Yahoo/Brave) carry on.
let googleBlockedUntil = 0;
async function googleDiscover(context, job, stores) {
  const want = (stores || []).filter(s => !s.url && (s.store !== 'official' || (s.officialSite && !MARKETPLACES.includes(s.officialSite))));
  if (!want.length || Date.now() < googleBlockedUntil || process.env.GOOGLE === '0') return {};
  const domainOf = s => (s.store === 'official' ? s.officialSite : STORE_DOMAIN[s.store]);
  const name = [job.name, job.variant].filter(Boolean).join(' ');
  const queries = [...(job.ean && /^\d{8,14}$/.test(job.ean) ? [job.ean] : []), searchQueries(job.name, job.brand, job.variant)[0]];
  const found = {};
  job._googleOk = false;
  const page = await context.newPage();
  try {
    for (const q of queries) {
      const missing = want.filter(s => !found[s.store]);
      if (!missing.length) break;
      await withSlot('google', () => open(page, googleUrl(q), { waitPrice: false }));
      const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
      if (isGoogleBlock(page.url(), text)) {
        googleBlockedUntil = Date.now() + 30 * 60_000;
        diag.push({ store: 'google', product: job.name, what: 'google captcha — paused 30 min', detail: page.url().slice(0, 80) });
        break;
      }
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({
        href: a.href, text: (a.querySelector('h3')?.innerText || a.innerText || '').trim().slice(0, 300),
      })));
      if (links.length > 15) job._googleOk = true;   // a real results page, not an error
      const isEanQuery = q === job.ean;
      for (const s of missing) {
        const domain = domainOf(s);
        const cands = [];
        for (const l of links) {
          const href = unwrapSearchLink(l.href);
          if (!isProductUrl(s.store, href)) continue;
          try { const h = new URL(href).hostname.replace(/^www\./, ''); if (!(h === domain || h.endsWith('.' + domain))) continue; } catch { continue; }
          cands.push({ href, text: l.text.replace(/\s*[-|:]\s*(amazon\.in|flipkart|croma|reliance digital)[\s\S]*$/i, '') });
        }
        // An EAN hit is exact even when the title is worded differently; still
        // require the model number + brand check so a wrong page is never used.
        const hit = pickBest(name, job.brand, cands, isEanQuery ? 0.5 : 0.55);
        if (hit) found[s.store] = hit.href;
      }
    }
  } catch (e) {
    diag.push({ store: 'google', product: job.name, what: 'google error', detail: String(e.message).slice(0, 120) });
  } finally { await page.close().catch(() => {}); }
  return found;
}

// ── Brand sites: read the product list from the sitemap ────────────────────
// Brand sites (in.jbl.com, samsung.com …) often block or JS-render their search,
// but publish every product URL in sitemap.xml. Loaded once per site per run.
const sitemapCache = new Map();
function loadSitemap(context, domain) {
  if (!sitemapCache.has(domain)) sitemapCache.set(domain, (async () => {
    const get = async u => {
      try {
        const r = await context.request.get(u, { timeout: 30_000, headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,text/plain,*/*' } });
        return r.ok() ? await r.text() : '';
      } catch { return ''; }
    };
    const base = `${process.env.SITEMAP_PROTO || 'https'}://${domain}`;
    const robots = await get(`${base}/robots.txt`);
    let roots = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]).filter(u => u.includes(domain.replace(/^www\./, '')));
    if (!roots.length) roots = [`${base}/sitemap_index.xml`, `${base}/sitemap.xml`];
    const urls = new Set();
    for (const root of roots.slice(0, 4)) {
      const xml = await get(root);
      const locs = sitemapLocs(xml);
      if (!locs.length) continue;
      const children = /<sitemapindex/i.test(xml) ? productSitemaps(locs) : [];
      if (children.length) {
        for (const c of children) {
          const cx = await get(c);
          // A second level of index (Shopify: sitemap.xml → sitemap_products_1.xml).
          const cl = sitemapLocs(cx);
          if (/<sitemapindex/i.test(cx)) for (const g of productSitemaps(cl).slice(0, 6)) sitemapLocs(await get(g)).forEach(u => urls.add(u));
          else cl.forEach(u => urls.add(u));
          if (urls.size > 60_000) break;
        }
      } else locs.forEach(u => urls.add(u));
      if (urls.size) break;
    }
    return [...urls].filter(u => !/\.(jpg|jpeg|png|webp|gif|pdf)(\?|$)/i.test(u));
  })());
  return sitemapCache.get(domain);
}

async function findViaSitemap(context, job, domain) {
  const urls = await loadSitemap(context, domain);
  if (!urls.length) return { hit: null, why: 'sitemap: none; ' };
  const name = [job.name, job.variant].filter(Boolean).join(' ');
  const cands = urls.map(href => ({ href, text: `${job.brand || ''} ${slugText(href)}` }));
  const hit = pickBest(name, job.brand, cands);
  return hit ? { hit } : { hit: null, why: `sitemap: ${urls.length} urls, no match; ` };
}

// ── Brand sites: the store's own catalogue ────────────────────────────────
// Each brand's Indian store is searched the way the site itself works (see
// BRAND_SITE_RULES): Shopify's search API, VTEX's catalogue API, or the list of
// Indian product pages in its sitemap / product-list page. Plain HTTP — no page
// rendering, no bot checks — so it is fast and works from the PC and the cloud.
const brandHost = d => (String(d).split('.').length > 2 ? d : `www.${d}`);
async function brandGet(context, url, accept = 'application/json,text/html,application/xml,*/*') {
  try {
    const r = await context.request.get(url, { timeout: 25_000, headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' } });
    return r.ok() ? await r.text() : null;
  } catch { return null; }
}
const brandJson = async (context, url) => { const t = await brandGet(context, url, 'application/json'); try { return t ? JSON.parse(t) : null; } catch { return null; } };

const shopifyCache = new Map();
/** Does this brand site run on Shopify (answers its search API)? Asked once per site. */
function isShopify(context, domain) {
  const rule = brandSiteRule(domain);
  if (rule?.shopify) return Promise.resolve(true);
  if (rule) return Promise.resolve(false);
  if (!shopifyCache.has(domain)) shopifyCache.set(domain, brandJson(context, `https://${brandHost(domain)}/search/suggest.json?q=a&resources[type]=product&resources[limit]=1`)
    .then(j => !!j?.resources?.results));
  return shopifyCache.get(domain);
}

const brandListCache = new Map();
/** Every Indian product page a brand site lists (sitemaps / product-list pages in its rule). */
function brandPages(context, domain) {
  const rule = brandSiteRule(domain);
  if (!rule || (!rule.sitemaps && !rule.lists && !rule.renders)) return Promise.resolve(null);
  if (!brandListCache.has(domain)) brandListCache.set(domain, (async () => {
    const urls = new Set();
    for (const sm of rule.sitemaps || []) {
      const xml = await brandGet(context, sm, 'application/xml,text/xml,*/*');
      if (!xml) continue;
      let locs = sitemapLocs(xml);
      if (/<sitemapindex/i.test(xml)) {
        const kids = productSitemaps(locs);
        locs = [];
        for (const k of kids) locs.push(...sitemapLocs(await brandGet(context, k, 'application/xml,*/*') || ''));
      }
      locs.filter(u => brandUrlOk(domain, u)).forEach(u => urls.add(u));
    }
    for (const lp of rule.lists || []) {
      const html = await brandGet(context, lp, 'text/html');
      if (!html) continue;
      for (const m of html.matchAll(/(?:href=|["'(])["']?((?:https?:)?\/\/[^"'\s)<>]+|\/[a-z0-9_-]+\/[^"'\s)<>]+)["')]/gi)) {
        try { const u = new URL(m[1].replace(/&amp;/g, '&'), lp); u.search = ''; if (brandUrlOk(domain, u.href)) urls.add(u.href.replace(/\/+$/, '')); } catch { /* bad link */ }
      }
    }
    const out = [...urls].map(href => ({ href, text: slugText(href) }));
    // Store pages drawn by script: open them and read each product link with its name.
    for (const rp of rule.renders || []) {
      const page = await context.newPage();
      try {
        await page.goto(rp, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(6000);
        for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(800); }
        const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href.split('?')[0], text: (a.innerText || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) })));
        const by = new Map();
        for (const l of links) if (brandUrlOk(domain, l.href) && l.text && l.text.length > (by.get(l.href)?.text.length || 0)) by.set(l.href, l);
        out.push(...by.values());
      } catch { /* page would not load — the other routes still run */ }
      finally { await page.close().catch(() => {}); }
    }
    return out;
  })());
  return brandListCache.get(domain);
}

async function findOnBrandSite(context, job, domain, bad = []) {
  const name = [job.name, job.variant].filter(Boolean).join(' ');
  const rule = brandSiteRule(domain) || {};
  const base = `https://${brandHost(domain)}`;
  const badKeys = new Set(bad.map(b => urlKey('official', b)));
  const pickBrandPage = (n, b, cands) => pickBrandPageAll(n, b, cands.filter(c => !badKeys.has(urlKey('official', c.href))));
  let why = '';
  if (await isShopify(context, domain)) {
    const seen = new Map();
    for (const q of searchQueries(job.name.replace(/\(?\b\d{1,2}\s*(gb)?\s*[/+|]\s*\d{2,4}\s*(gb|tb)?\)?|\b\d{1,4}\s*(gb|tb)\b/gi, ' '), job.brand, job.variant)) {
      const j = await brandJson(context, `${base}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10`);
      const list = j?.resources?.results?.products;
      if (!Array.isArray(list)) { why += `shopify search: no answer; `; continue; }
      for (const p of list) {
        const href = new URL(String(p.url || '').split('?')[0], base).href;
        if (!seen.has(href)) seen.set(href, { href, text: `${job.brand || ''} ${p.title || ''}` });
      }
      const hit = pickBrandPage(name, job.brand, [...seen.values()]);
      if (hit) return { hit };
    }
    why += `shopify search: ${seen.size} products, none ours; `;
  }
  if (rule.vtex) {
    for (const q of searchQueries(job.name, job.brand, job.variant).reverse()) {
      const j = await brandJson(context, `${base}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(q.replace(/\(?\b\d{1,2}\s*(gb)?\s*[/+|]\s*\d{2,4}\s*(gb|tb)?\)?/gi, ' ').replace(/\s+/g, ' ').trim())}&_from=0&_to=19`);
      const v = Array.isArray(j) ? vtexPick(j, name, job.brand) : null;
      if (v) return { hit: { href: v.url, text: v.title }, data: v };
      why += `catalogue: ${Array.isArray(j) ? j.length : 'no answer'} for "${q}"; `;
    }
  }
  for (const tpl of rule.searches || []) {
    const seen = new Map();
    for (const q of searchQueries(job.name, job.brand, job.variant).reverse()) {
      const html = await brandGet(context, tpl.replace('{q}', encodeURIComponent(q.replace(/\(?\b\d{1,2}\s*(gb)?\s*[/+|]\s*\d{2,4}\s*(gb|tb)?\)?/gi, ' ').replace(/\s+/g, ' ').trim())), 'text/html');
      for (const m of (html || '').matchAll(/(?:href=|["'(])["']?((?:https?:)?\/\/[^"'\s)<>]+|\/[a-z0-9_-]+\/[^"'\s)<>]+)["')]/gi)) {
        try { const u = new URL(m[1].replace(/&amp;/g, '&'), tpl); u.search = ''; if (brandUrlOk(domain, u.href)) seen.set(u.href, { href: u.href, text: `${job.brand || ''} ${slugText(u.href)}` }); } catch { /* bad link */ }
      }
      const hit = pickBrandPage(name, job.brand, [...seen.values()]);
      if (hit) return { hit };
    }
    why += `site search: ${seen.size} pages, none ours; `;
  }
  const pages = await brandPages(context, domain);
  if (pages) {
    const hit = pickBrandPage(name, job.brand, pages.map(p => ({ href: p.href, text: `${job.brand || ''} ${p.text}` })));
    if (hit) return { hit };
    why += `site list: ${pages.length} pages, none ours; `;
  }
  return { hit: null, why };
}

/**
 * Price / stock straight from the brand store's own product data (Shopify product
 * JSON, VTEX catalogue), for the product's RAM / storage. null when the site has none.
 */
async function brandProductData(context, job, url, s) {
  let u; try { u = new URL(url); } catch { return null; }
  const domain = s.officialSite || u.hostname;
  const name = [job.name, job.variant].filter(Boolean).join(' ');
  const handle = u.pathname.match(/\/products\/([^/?#]+)/)?.[1];
  if (handle && (await isShopify(context, domain) || /\/products\//.test(u.pathname))) {
    const prod = await brandJson(context, `${u.origin}/products/${handle}.js`);
    const v = prod ? shopifyPick(prod, name, u.searchParams.get('variant')) : null;
    if (v?.price) return { ...v, url: `${u.origin}/products/${handle}?variant=${v.variantId}`, how: 'store data (Shopify)' };
  }
  if (brandSiteRule(domain)?.vtex || /\/p$/.test(u.pathname)) {
    const linkText = u.pathname.match(/^\/([^/]+)\/p\/?$/)?.[1];
    if (linkText) {
      const j = await brandJson(context, `${u.origin}/api/catalog_system/pub/products/search/${linkText}/p`);
      const v = Array.isArray(j) && j.length ? (vtexPick(j, name, job.brand, u.searchParams.get('skuId')) || vtexPick(j, name, job.brand, u.searchParams.get('skuId'), true)) : null;
      if (v?.price) return { ...v, how: 'store data (catalogue)' };
    }
  }
  // Xiaomi: the store's item API lists every RAM / storage / colour with price and stock.
  const miTag = /(^|\.)mi\.com$/.test(u.hostname) && u.pathname.match(/\/in\/product\/([a-z0-9-]+)/i)?.[1];
  if (miTag) {
    const j = await brandJson(context, `https://in-go.buy.mi.com/in/v2/item/productdetail?tag=${miTag}`);
    const items = (j?.data?.item_detail?.spu_list || []).flatMap(x => x.item_list || []);
    const want = memOf(name);
    const sc = items.map(it => ({ it, m: memMatch(it.item_name, want) })).filter(o => o.m !== false && Number(o.it.price) > 0);
    sc.sort((a, b) => (b.m === true) - (a.m === true) || (!b.it.is_out_of_stock) - (!a.it.is_out_of_stock) || a.it.price - b.it.price);
    const it = sc[0]?.it;
    if (it) return { price: Number(it.price), mrp: Number(it.market_price) > Number(it.price) ? Number(it.market_price) : null, inStock: !!it.is_sale && !it.is_out_of_stock, title: it.item_name, url, how: 'store data (Mi)' };
  }
  // realme: product API with each SKU's name (RAM + storage) and price.
  const rmId = /buy\.realme\.com$/.test(u.hostname) && u.pathname.match(/\/in\/goods\/(\d+)/)?.[1];
  if (rmId) {
    const j = await brandJson(context, `https://api.realme.com/in/product/detail?productId=${rmId}`);
    const skus = Object.values(j?.data || {}).filter(x => x && x.skuId && Number(x.price) > 0);
    const want = memOf(name);
    const sc = skus.map(x => ({ x, m: memMatch(`${x.skuName || ''} ${x.productName || ''}`, want) })).filter(o => o.m !== false);
    sc.sort((a, b) => (b.m === true) - (a.m === true) || a.x.price - b.x.price);
    const x = sc[0]?.x;
    if (x) return { price: Number(x.price), mrp: Number(x.mrpPrice) > Number(x.price) ? Number(x.mrpPrice) : null, inStock: null, title: x.skuName || x.productName, url, how: 'store data (realme)' };
  }
  return null;
}

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

/**
 * Amazon "Save Extra with N offers" layout (what a signed-out browser gets).
 * Each offer line has a "See All"/"Details" popup whose content Amazon loads from
 * a URL written in the page (data-a-modal). Fetching those URLs from the page
 * gives every bank offer with its terms — no clicking, works for every product.
 */
async function amazonSoppOffers(page, price) {
  const texts = await page.evaluate(async () => {
    const out = { lines: [], popups: [] };
    // Each visible offer line, full text (Amazon truncates the visible copy).
    for (const el of document.querySelectorAll('#soppATF_feature_div .a-truncate-full, #sopp-primary-ingress-0 .a-truncate-full')) {
      out.lines.push((el.textContent || '').replace(/\s+/g, ' ').trim());
    }
    const toText = html => {
      const d = new DOMParser().parseFromString(html, 'text/html');
      d.querySelectorAll('script, style').forEach(n => n.remove());
      d.querySelectorAll('br, p, div, li, tr, h1, h2, h3, h4, h5, section').forEach(n => n.append('\n'));
      return (d.body?.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n');
    };
    const urls = [];
    for (const el of document.querySelectorAll('[data-a-modal]')) {
      try {
        const m = JSON.parse(el.getAttribute('data-a-modal'));
        if (m.url && /viewName:(bankOffer|cashback)SecondaryView/.test(m.url) && !urls.includes(m.url)) urls.push(m.url);
      } catch { /* not JSON */ }
    }
    for (const u of urls.slice(0, 3)) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (r.ok) out.popups.push(toText(await r.text()));
      } catch { /* blocked — the lines above still count */ }
    }
    return out;
  }).catch(() => ({ lines: [], popups: [] }));
  // Full popup lists first; the one-line summaries add anything they missed.
  const offers = [];
  const add = o => { if (!offers.some(x => x.bank === o.bank && x.cardType === o.cardType && x.offerType === o.offerType && x.amount === o.amount && x.percent === o.percent && x.maxDiscount === o.maxDiscount)) offers.push(o); };
  for (const t of texts.popups) extractOffers(t).forEach(add);
  for (const l of texts.lines) {
    const o = parseOffer(l.replace(/\b(see all|details|shop items|sign up for free)\b/gi, ''));
    if ((o.bank || o.offerType === 'cashback') && (o.amount || o.percent)) add(o);
  }
  return { offers, popupCount: texts.popups.length, lineCount: texts.lines.length };
}

/** Amazon: open "See all offers & discounts" and read exact savings, both tabs. */
async function amazonPanelOffers(page, price) {
  try {
    // Only a visible link — Amazon also keeps hidden copies of it in the page.
    const link = page.getByText(/see all offers/i).filter({ visible: true }).first();
    if (!(await link.count())) return [];
    await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await link.click({ timeout: 5000 });
    await page.getByText(/^PAYMENT OFFERS$/i).filter({ visible: true }).first().waitFor({ timeout: 7000 }).catch(() => {});
    await sleep(800);
    const text = () => page.evaluate(() => document.body.innerText);
    const offers = parseAmazonPanel(await text(), 'Full swipe', price);
    const emiTab = page.getByText(/^EMI plans$/i).filter({ visible: true }).first();
    if (await emiTab.count()) {
      await emiTab.click({ timeout: 3000 }).catch(() => {});
      await sleep(900);
      for (const o of parseAmazonPanel(await text(), 'EMI', price)) {
        // Same card and amount on both tabs = one offer valid for both.
        const same = offers.find(x => x.bank === o.bank && x.cardType === o.cardType && x.amount === o.amount && x.offerType === o.offerType);
        if (same) same.mode = 'EMI & Full swipe'; else offers.push(o);
      }
    }
    return offers;
  } catch { return []; }
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
    const vis = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const shown = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const why = [];

    // 1. The price block in the centre column (Amazon moves and renames it often,
    //    so several known places are tried; the first one holding a price wins).
    const PRICE_BOXES = '#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop, #corePrice_desktop, ' +
      '#apex_offerDisplay_desktop, #apex_price_to_pay_value, #tp_price_block_total_price_ww, #buyBoxAccordion, ' +
      '#newAccordionRow_0, #buybox, #desktop_buybox, #priceblock_ourprice, #priceblock_dealprice';
    const PAY = '.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .reinventPricePriceToPayMargin .a-offscreen, ' +
      '#price_inside_buybox, #priceblock_ourprice, #priceblock_dealprice, .a-price[data-a-color="price"] .a-offscreen, .a-price .a-offscreen';
    const box = [...document.querySelectorAll(PRICE_BOXES)]
      .find(b => b.querySelector(PAY + ', .a-price-whole') || /^#?priceblock/.test(b.id));
    let pt = '';
    if (box) {
      const pay = box.matches('#priceblock_ourprice, #priceblock_dealprice') ? box : box.querySelector(PAY);
      const whole = box.querySelector('.priceToPay .a-price-whole, .reinventPricePriceToPayMargin .a-price-whole, .a-price-whole');
      pt = txt(pay) || (whole ? '₹' + txt(whole) : '');
    }
    // 2. Hidden fields Amazon fills with the selected variant's price.
    if (!num(pt)) {
      for (const sel of ['#twister-plus-price-data-price', '#attach-base-product-price', 'input[name="displayedPrice"]']) {
        const v = document.querySelector(sel)?.value;
        if (num(v)) { pt = '₹' + v; why.push('hidden field ' + sel); break; }
      }
    }
    // 3. Last resort: "-21% ₹13,497" as shown at the top of the centre column.
    if (!num(pt)) {
      const cc = vis(document.querySelector('#centerCol, #ppd'));
      const m = cc.match(/-\s?\d{1,2}%\s*₹\s?([\d,]+(?:\.\d{1,2})?)/) || cc.match(/(?:Deal Price|Price|Offer price):?\s*₹\s?([\d,]+)/i);
      if (m) { pt = '₹' + m[1]; why.push('centre column text'); }
    }
    if (num(pt)) { res.price = num(pt); res.priceText = pt; }

    const mrpSel = '.basisPrice .a-offscreen, .a-price.a-text-price .a-offscreen, .apex-basisprice-offscreen-label, .apex-basisprice-value .a-offscreen';
    const mrpEl = [box?.querySelector(mrpSel), document.querySelector('#centerCol ' + mrpSel.split(', ').join(', #centerCol '))].find(e => e && num(txt(e)));
    if (mrpEl) res.mrp = num(txt(mrpEl).replace(/^[^\d₹]*/, ''));
    if (!res.mrp) {
      const m = vis(document.querySelector('#centerCol, #ppd')).match(/M\.?R\.?P\.?:?\s*₹\s?([\d,]+)/i);
      if (m) res.mrp = num(m[1]);
    }

    // Availability. innerText = only what is visible (Amazon keeps hidden
    // "Currently unavailable" templates in the page; textContent would read them).
    const av = vis(document.querySelector('#availability')).toLowerCase();
    if (av) res.inStock = !/(currently unavailable|out of stock)/.test(av);
    // The buy buttons may sit inside a collapsed "With / Without Exchange" accordion:
    // present-but-hidden still means Amazon sells it.
    const buyBox = document.querySelector('#buybox, #desktop_buybox, #rightCol');
    const bbText = vis(buyBox).toLowerCase();
    const saysUnavailable = /no featured offers available|currently unavailable/.test(bbText + ' ' + av);
    const buyBtn = document.querySelector('#add-to-cart-button, #buy-now-button, input[name="submit.add-to-cart"], #add-to-cart-button-ubb');
    const canBuy = shown(buyBtn) || (!saysUnavailable && (!!buyBtn || !!document.querySelector('#buyBoxAccordion')));
    if (canBuy) res.inStock = true;

    // Only an explicit "no featured offers" / "currently unavailable" with no way to
    // buy means Amazon isn't selling it. Any other ₹ on such a page belongs to
    // variants, ads or "customers also viewed".
    const notSold = !canBuy && saysUnavailable;
    if (notSold) {
      res.inStock = false;
      res.price = null; res.priceText = null; res.mrp = null;
    }
    res.amazonNoBuyBox = notSold;                       // really not sold right now
    res.amazonUnreadable = !res.price && !notSold;      // sold (or unclear) but the price couldn't be read
    res.amazonWhy = why.join(', ');
    res.amazonBuyBox = bbText.slice(0, 90);
  }

  // Generic: the biggest, un-struck rupee amount near the top of the page is
  // the selling price; a struck-through larger one next to it is the M.R.P.
  if (!res.price && store !== 'amazon') {
    const cands = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 2) continue;
      const t = txt(el);
      if (!/^(₹|rs\.?)\s?[\d,]+(\.\d{1,2})?\s*\*?\s*(\/-)?\s*\*?$/i.test(t)) continue;
      // "₹641/month", "EMI from ₹641" — an instalment, never the product price.
      // Only the text right next to the amount — not the whole section.
      const parentT = txt(el.parentElement);
      const around = parentT.length <= 80 ? parentT
        : [el.previousSibling?.textContent, el.nextSibling?.textContent].map(x => (x || '').trim().slice(0, 30)).join(' ');
      if (/(\/\s?m(o|onth)?\b|per month|p\.m\.|\bemi\b|\bmonths?\b)/i.test(around)) continue;
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
  // "₹4,602.86/mo with low-cost EMI … or ₹55,999" (Google Store): the full price follows "or".
  if (!res.price && store === 'official') {
    const m = (document.body?.innerText || '').match(/\/mo[^₹\n]{0,80}\bor\s*₹\s?([\d,]+(?:\.\d{1,2})?)/i);
    if (m && num(m[1]) > 99) { res.price = num(m[1]); res.priceText = '₹' + m[1]; }
  }
  if (store !== 'amazon' && res.ldPrice && (!res.price || res.price < res.ldPrice * 0.5)) {
    res.price = res.ldPrice; res.priceText = '₹' + res.ldPrice;   // the store's own structured price
  }

  if (!res.title) res.title = txt(document.querySelector('h1')) || document.title || null;
  const body = (document.body?.innerText || '');
  // Where "similar products / customers also viewed" rails begin: a line that is
  // only that heading, in the lower part of the page. (Reliance has a "Similar
  // Products" *button* right above its offers — that one must not cut anything.)
  const railsAt = (() => {
    const re = /^\s*(similar products|customers (also|who) (viewed|bought)[^\n]*|frequently bought together|you may also like|recommended for you|sponsored products[^\n]*)\s*$/gim;
    let m;
    while ((m = re.exec(body))) if (m.index > body.length * 0.35) return m.index;
    return -1;
  })();
  // What the page shows beats the store's structured data: Reliance marks
  // "Currently unavailable online … Notify Me" pages as InStock in its JSON-LD.
  // Only the product part of the page counts (not "similar products" below).
  if (store !== 'amazon') {
    const head = (railsAt > 0 ? body.slice(0, railsAt) : body).slice(0, 12000).toLowerCase();
    // Buttons decide, not words: offer text like "Buy now, pay later" must not
    // make an unavailable product look buyable.
    const btns = [...document.querySelectorAll('button, a, input[type="submit"], [role="button"]')]
      .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top + window.scrollY < 2500; })
      .map(b => ({ t: (b.innerText || b.value || '').replace(/\s+/g, ' ').trim().toLowerCase(), off: b.disabled || b.getAttribute('aria-disabled') === 'true' }));
    // Flipkart writes "Buy now at ₹15,999" / "Add to cart" with extra words — match the start.
    const BUY = /^(add to cart|buy now|add to bag|go to cart|buy)(\b|$)/;
    // Flipkart's buy bar is made of plain <div>s, not buttons — look at short visible
    // text blocks too (not only <button>/<a>), skipping anything greyed out.
    const looksBuy = el => {
      const t = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      // Exactly a buy label (optionally "at ₹15,999") — not offer text like "Buy now, pay later".
      if (!t || !/^(add to cart|buy now|add to bag|go to cart)( at ₹\s?[\d,]+(\.\d+)?)?$/.test(t)) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      if (el.closest('[disabled],[aria-disabled="true"]')) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
      // Greyed-out buttons are usually faded on a parent; opacity multiplies down the tree.
      let op = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      return op > 0.5;
    };
    const realBtn = btns.some(b => !b.off && BUY.test(b.t) && !/emi|pay later/.test(b.t));
    const notifyFirst = btns.some(b => /^(notify me|notify when available)$/.test(b.t));
    // A div that merely reads "Buy now" counts only when the page isn't offering "Notify me".
    const buyable = realBtn || (!notifyFirst && [...document.querySelectorAll('div, span, li')].some(el => el.childElementCount <= 3 && looksBuy(el)));
    const notifyBtn = btns.some(b => /^(notify me|notify when available)$/.test(b.t));
    const unavailable = notifyBtn || /(currently unavailable|out of stock|sold out|coming soon)/.test(head);
    // A working Buy / Add-to-cart button for the open variant beats everything else:
    // "Sold out" on another colour/variant swatch, or structured data describing a
    // different variant (Flipkart), must not mark the product out of stock.
    if (buyable) res.inStock = true;
    else if (unavailable) res.inStock = false;
    const hitBtn = btns.find(b => !b.off && BUY.test(b.t) && !/emi|pay later/.test(b.t));
    res.stockWhy = buyable ? (hitBtn ? `button "${hitBtn.t.slice(0, 40)}"` : 'buy bar')
      : notifyBtn ? 'notify-me button'
      : unavailable ? 'unavailable text' : (res.inStock == null ? 'nothing' : 'structured data');
  }
  // Text above the recommendation rails holds the offers; keep it bounded.
  res.text = (railsAt > 0 ? body.slice(0, railsAt) : body).slice(0, 60_000);
  return res;
}

/** Amazon's price for this page read from a fresh copy of its HTML (no scripts run). */
async function amazonPriceFromHtml(page) {
  return page.evaluate(async () => {
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const num = s => { const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
    const t = sel => (doc.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
    const avail = t('#availability').replace(/\{.*$/, '').toLowerCase();
    const said = (avail || t('#outOfStock')).slice(0, 90);
    let price = num(doc.querySelector('#twister-plus-price-data-price')?.value)
      || num(t('#corePriceDisplay_desktop_feature_div .priceToPay .a-price-whole') || t('#corePriceDisplay_desktop_feature_div .a-price-whole'))
      || num(t('#corePrice_feature_div .a-offscreen')) || num(t('#apex_desktop .a-price-whole'));
    const notSold = !price && /currently unavailable|no featured offers/.test(said + ' ' + t('#outOfStock').toLowerCase());
    const mrp = num(t('#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen') || t('.basisPrice .a-offscreen'));
    return { price: price || null, mrp: mrp && price && mrp > price ? mrp : null, inStock: avail ? !/currently unavailable|out of stock/.test(avail) : null, notSold, said };
  });
}

/** Price of the first seller in Amazon's "See all buying options" panel, or null. */
async function amazonOfferListPrice(page) {
  const btn = await page.$('#buybox-see-all-buying-choices a, #buybox-see-all-buying-choices input, a[title="See All Buying Options"], #aod-ingress-link, a[href*="aod=1"]');
  if (!btn) return null;
  await btn.click().catch(() => {});
  await page.waitForSelector('#aod-pinned-offer .a-price .a-offscreen, #aod-offer .a-price .a-offscreen, #aod-offer-list .a-price .a-offscreen', { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('#aod-pinned-offer .a-price .a-offscreen, #aod-offer .a-price .a-offscreen, #aod-offer-list .a-price .a-offscreen')) {
      const t = (el.textContent || '').trim();
      const n = Number(t.replace(/[^\d.]/g, ''));
      if (n > 0) return { price: n, text: t };
    }
    return null;
  });
}

/** Select the product's RAM / storage option on a variant picker, if it isn't selected. */
async function pickMemoryVariant(page, job) {
  const want = wantedMemory([job.name, job.variant].filter(Boolean).join(' '));
  if (want.ram == null && want.rom == null) return null;
  const opts = await page.evaluate(() => {
    const norm = e => (e.innerText || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('label, button, [role="radio"], [role="option"], [role="button"], li, a, span, div, p')].filter(e => {
      const t = norm(e);
      if (!t || t.length > 40 || !/\d\s*(gb|tb)\b/i.test(t)) return false;
      // Only option-like text ("6 GB, 128 GB", "8GB | 256GB RAM") — not titles or specs.
      if (t.replace(/\d+\s*(gb|tb)|ram|rom|storage|memory|internal|[\s,+/|&-]/gi, '').length > 2) return false;
      if ((t.match(/\d+\s*(gb|tb)/gi) || []).length > 2) return false;  // a whole row of options, not one
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || r.top + window.scrollY > 2500) return false;
      return ![...e.children].some(c => norm(c) === t);                // innermost with this text
    });
    window.__pwOpts = els;
    return els.map(e => {
      const inp = e.tagName === 'LABEL' ? (e.control || document.getElementById(e.htmlFor)) : e.querySelector('input[type="radio"]');
      const aria = ['aria-checked', 'aria-pressed', 'aria-selected'].map(k => (e.closest(`[${k}]`) || e).getAttribute(k)).includes('true');
      const cls = /\b(active|selected|is-selected|checked|current)\b/i.test(String(e.className || '') + ' ' + String(e.parentElement?.className || ''));
      const href = e.closest('a')?.getAttribute('href') || '';
      return { t: norm(e), sel: !!inp?.checked || aria || cls, nav: !!href && !href.startsWith('#') && !href.includes('?') };
    });
  });
  const verdicts = opts.map(o => memoryOptionMatches(o.t, want));
  const ours = verdicts.map((v, i) => v === true ? i : -1).filter(i => i >= 0);
  if (!ours.length || !verdicts.includes(false)) return null;          // no picker with our variant
  if (ours.some(i => opts[i].sel)) return 'already selected';
  const i = ours.find(i => !opts[i].nav) ?? ours[0];
  const before = await page.evaluate(() => document.body.innerText.length);
  await page.evaluate(i => window.__pwOpts[i].click(), i);
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await sleep(1500);
  if (opts[i].nav) await page.waitForLoadState('domcontentloaded').catch(() => {});
  return `picked "${opts[i].t}" (${before})`;
}

async function scrapeStore(context, job, s) {
  if (breaker.isOpen(s.store)) return { store: s.store, status: 'blocked', skipped: true, note: 'Skipped for now: this store has been blocking this run' };
  const page = await context.newPage();
  const tag = `${s.store}-${slug(job.name)}`;
  try {
    let url = s.url;
    if (!url) {
      if (s.store === 'official' && (!s.officialSite || MARKETPLACES.includes(s.officialSite))) {
        return s.officialSite ? { store: s.store, status: 'not_listed' }
          : { store: s.store, status: 'not_found', note: 'No brand site known — paste the product URL in Market Prices' };
      }
      const domain = s.store === 'official' ? s.officialSite : STORE_DOMAIN[s.store];
      let why = '';
      // 0. Brand sites: the store's own catalogue first (search API / sitemap) — exact and quick.
      if (s.store === 'official') {
        const b = await findOnBrandSite(context, job, domain, [...(s._bads || []), ...(s._bad ? [s._bad] : [])]).catch(e => ({ hit: null, why: `brand site: ${String(e.message).slice(0, 60)}; ` }));
        if (b.hit) { url = b.hit.href; s._data = b.data || null; }
        else why += b.why || '';
      }
      // 1. Google (shared by all stores of this product — one search, not five).
      // A retry after a wrong saved page searches Google again just for this store.
      if (!url) {
        const g = s._retried ? await googleDiscover(context, job, [s]) : await (job._google ||= googleDiscover(context, job, job.stores));
        if (g[s.store]) url = g[s.store];
        else if (Date.now() < googleBlockedUntil) why += 'google: paused (captcha); ';
        else why += 'google: no match; ';
      }
      // When Google answered properly and still didn't show this store, the
      // product is most likely not sold there: one quick store search, no more.
      const quick = job._googleOk && !url;
      // 2. Brand sites: the sitemap — no search page, no bot checks.
      if (!url && s.store === 'official' && !brandSiteRule(domain)) {
        const m = await findViaSitemap(context, job, domain);
        if (m.hit) url = m.hit.href; else why += m.why;
      }
      // 3. Amazon blocks its own search for cloud servers, so the other engines next.
      if (!url && s.store === 'amazon' && !quick) {
        const e = await findViaEngine(page, s.store, job, domain);
        if (e.hit) url = e.hit.href; else why += 'engines: ' + e.why;
      }
      if (!url && !(quick && s.store === 'official')) {
        const qs = searchQueries(job.name, job.brand, job.variant);
        for (const q of quick ? qs.slice(-1) : qs) {
          const su = storeSearchUrl(s.store, q, s.officialSite);
          if (!su) break;
          let blocked;
          try { blocked = await withSlot(s.store, async () => {
            await open(page, su);
            if (s.store === 'amazon') await passInterstitial(page, su);
            // Croma / Reliance render results with JS after the page shell.
            if (s.store === 'croma' || s.store === 'reliance') {
              await page.waitForSelector('a[href*="/p/"], a[href*="/product/"]', { timeout: 6_000 }).catch(() => {});
            }
            return isBlocked(page);
          }); } catch (e) { blocked = `error: ${String(e.message).slice(0, 50)}`; }
          // A failed or blocked store search falls through to the search engines.
          if (blocked) { why += ` store search blocked (${blocked});`; break; }
          const f = await findOnSearch(page, s.store, job, s.officialSite);
          if (f.hit) { url = f.hit.href; break; }
          why += ` query "${q}": ${f.count} links` + (f.top ? `, best "${f.top.text.slice(0, 50)}" (${f.top.score.toFixed(2)})` : '') + ';';
        }
      }
      // Store search found nothing (or was blocked) — try the search engines.
      if (!url && s.store !== 'amazon' && !quick) {
        const e = await findViaEngine(page, s.store, job, domain);
        if (e.hit) url = e.hit.href; else why += ' engines: ' + e.why;
      }
      if (url && s._bad && urlKey(s.store, url) === urlKey(s.store, s._bad)) url = null;
      if (!url) {
        await debugDump(page, tag + '-search');
        // "Not listed" is only said when a page was really read and the product was
        // not on it. A blank page or a sitemap that would not load proves nothing, and
        // saying "not sold here" made the ERP stop checking the store for days.
        const verdict = classifyMiss(why);
        const what = verdict === 'blocked' ? 'search blocked' : verdict === 'not_listed' ? 'not found in search' : 'could not look properly';
        diag.push({ store: s.store, product: job.name, what, detail: `${why} · ${await pageSnippet(page)}` });
        return verdict === 'not_listed'
          ? { store: s.store, status: 'not_listed', note: why.trim().slice(0, 200) }
          : { store: s.store, status: verdict, note: (verdict === 'blocked' ? why : `Not found yet (will retry): ${why}`).trim().slice(0, 200) };
      }
    }
    // Reliance (Fynd) draws Add to cart / Notify me from its catalog API. Its answer
    // ("sellable", per-size "is_available") is what the store itself goes by, so it
    // beats reading buttons — those differ by layout and by pincode.
    const api = [];
    if (s.store === 'reliance') {
      page.on('response', async resp => {
        try {
          const u = resp.url();
          if (!/reliancedigital|fynd|jiox/i.test(u) || /\.(js|css|png|jpe?g|webp|svg|woff2?)(\?|$)/i.test(u)) return;
          const t = await resp.text();
          if (!/"(sellable|is_available)"\s*:/.test(t)) return;
          const pick = k => [...t.matchAll(new RegExp(`"${k}"\\s*:\\s*(true|false)`, 'g'))].map(m => m[1] === 'true');
          const body = resp.request().postData() || '';
          const op = (body.match(/"operationName"\s*:\s*"([^"]+)"/) || body.match(/query\s+(\w+)/) || [])[1] || '';
          api.push({ full: u + ' ' + body.slice(0, 3000), u: (op ? 'gql:' + op : u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*/, '').slice(-70)), sellable: pick('sellable'), avail: pick('is_available') });
        } catch { /* body gone */ }
      });
    }
    // Brand stores with their own product data (Shopify / VTEX): price and stock for our
    // RAM / storage come from it — the page is still opened for offers.
    const sd = s.store === 'official' ? (s._data?.price ? s._data : await brandProductData(context, job, url, s).catch(() => null)) : null;
    if (sd?.url) url = sd.url;
    const load = () => withSlot(s.store, async () => {
      await open(page, url);
      if (s.store === 'amazon') await passInterstitial(page, url);
      return isBlocked(page);
    });
    let blocked = await load();
    if (blocked) { await sleep(4000 + Math.random() * 3000); blocked = await load(); } // one polite retry
    if (blocked && sd?.price) {
      return { store: s.store, url, status: 'ok', price: sd.price, mrp: sd.mrp, inStock: sd.inStock, title: sd.title, priceText: '₹' + sd.price, offers: [], note: `Price from the brand's ${sd.how}` };
    }
    if (blocked) {
      await debugDump(page, tag);
      diag.push({ store: s.store, product: job.name, what: `product page blocked (${blocked})`, detail: await pageSnippet(page) });
      return { store: s.store, url, status: 'blocked', note: blocked };
    }
    await expandOffers(page, s.store);
    // Brand sites often open on their default variant whatever the link says (HMD
    // turns ?sku=<6 GB> into the 4 GB one): pick our RAM / storage on the page.
    if (s.store === 'official' && !sd) await pickMemoryVariant(page, job).catch(() => null);
    // Reliance draws its Add to cart / Notify me bar after the price, from a later API call.
    if (s.store === 'reliance') {
      await page.waitForFunction(() => /add to cart|notify me|buy now|out of stock|unavailable/i.test(document.body?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
      await sleep(800);
    }
    const r = await page.evaluate(readPage, s.store);
    if (sd?.price) {
      Object.assign(r, { price: sd.price, priceText: '₹' + sd.price, mrp: sd.mrp ?? r.mrp, inStock: sd.inStock ?? r.inStock, ldPrice: null });
      if (!r.title || brandScore([job.name, job.variant].filter(Boolean).join(' '), job.brand, r.title) < 0.55) r.title = sd.title || r.title;
    }
    if (s.store === 'reliance') {
      await sleep(500);
      // Only this product's own answer — "similar products" lists carry "sellable" too.
      const slug = new URL(page.url()).pathname.split('/').filter(Boolean).pop() || '#';
      const mine = api.filter(a => a.sellable.length && a.full.includes(slug));
      const any = mine.find(a => /\/sizes|size/i.test(a.u)) || mine[0];
      if (any) {
        const ok = any.sellable[0];
        r.inStock = ok;
        r.stockWhy = `store api sellable=${ok} (${any.u})`;
      }
    }
    // Is this page really our product? A link saved earlier (or picked from a
    // search) can point at a sibling model — SB550 for SB590, SB180 for Bar 2.1
    // Essential. A link the admin pasted is trusted as is.
    const wanted = [job.name, job.variant].filter(Boolean).join(' ');
    const fits = s.store === 'official' ? brandScore(wanted, job.brand, `${job.brand || ''} ${r.title}`) >= 0.55 || brandScore(wanted, job.brand, `${job.brand || ''} ${slugText(page.url())}`) >= 0.55
      : titleScore(wanted, job.brand, r.title) >= 0.55;
    // A brand page for another RAM / storage ("Galaxy A17 5G (6 GB Memory)" for the 8 GB one):
    // try the next candidate page.
    const memWrong = s.store === 'official' && !sd && memMatch(r.title, memOf(wanted)) === false;
    if (!s.locked && s.store === 'official' && (memWrong || (r.title && !fits)) && (s._tries || 0) < 3) {
      diag.push({ store: s.store, product: job.name, what: memWrong ? 'brand page is another RAM/storage' : 'brand page is a different product', detail: `${String(r.title).slice(0, 80)} · ${page.url()}` });
      await page.close().catch(() => {});
      return scrapeStore(context, job, { ...s, url: null, _data: null, _tries: (s._tries || 0) + 1, _bads: [...(s._bads || []), page.url(), url] });
    }
    if (!s.locked && r.title && !fits) {
      diag.push({ store: s.store, product: job.name, what: 'page is a different product', detail: `${r.title.slice(0, 80)} · ${page.url()}` });
      if (s.url && !s._retried) {
        await page.close().catch(() => {});
        return scrapeStore(context, job, { ...s, url: null, _retried: true, _bad: page.url() });
      }
      return { store: s.store, status: 'not_listed', note: `Closest page was a different product: ${r.title.slice(0, 80)}` };
    }
    if (!r.price && r.amazonNoBuyBox) {
      return { store: s.store, url: page.url(), status: 'not_found', inStock: false, title: r.title, note: `Not sold on Amazon right now (no featured offer / unavailable)${r.amazonBuyBox ? ` — page said: "${r.amazonBuyBox}"` : ''}` };
    }
    if (!r.price && r.amazonUnreadable) {
      // Usually the page simply wasn't finished: let it settle and read again, then
      // reload once.
      for (const step of ['settle', 'reload']) {
        if (step === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
        await amazonSettle(page, 25_000);
        await sleep(1500);
        const again = await page.evaluate(readPage, s.store).catch(() => null);
        if (again?.price) { Object.assign(r, again); break; }
        if (again?.amazonNoBuyBox) { Object.assign(r, again); break; }
      }
    }
    if (!r.price && r.amazonNoBuyBox) {
      return { store: s.store, url: page.url(), status: 'not_found', inStock: false, title: r.title, note: `Not sold on Amazon right now (no featured offer / unavailable)${r.amazonBuyBox ? ` — page said: "${r.amazonBuyBox}"` : ''}` };
    }
    if (!r.price && r.amazonUnreadable) {
      // No buy box for us, but sellers do sell it ("See All Buying Options"): the
      // offers panel lists their prices — take the first (featured / lowest) one.
      // The page in the browser is missing its price block: read Amazon's own HTML
      // for this page directly (same as the server sent it) before giving up.
      const raw = await amazonPriceFromHtml(page).catch(() => null);
      if (raw?.price) {
        return {
          store: s.store, url: page.url(), status: 'ok', price: raw.price, mrp: raw.mrp || r.mrp, inStock: raw.inStock ?? true,
          title: r.title, priceText: '₹' + raw.price, offers: parseAmazonCards(r.text), note: null,
        };
      }
      if (raw?.notSold) {
        return { store: s.store, url: page.url(), status: 'not_found', inStock: false, title: r.title, note: `Not sold on Amazon right now — page said: "${raw.said}"` };
      }
      const aod = await amazonOfferListPrice(page).catch(() => null);
      if (aod) {
        return {
          store: s.store, url: page.url(), status: 'ok', price: aod.price, mrp: r.mrp, inStock: true,
          title: r.title, priceText: aod.text, offers: [],
          note: 'Price from Amazon\'s "See all buying options" list (no buy box shown)',
        };
      }
      // Amazon showed the product but its price block wasn't where we look: say so
      // (instead of "not sold"), keep a copy of the page, and let the next run retry.
      const snippet = await pageSnippet(page);
      await debugDump(page, tag + '-amazon-price');
      diag.push({ store: s.store, product: job.name, what: 'amazon price not read', detail: `${page.url()} · ${snippet}` });
      return { store: s.store, url: page.url(), status: 'not_found', title: r.title, note: `Amazon page opened but the price could not be read — will retry. Page showed: "${(r.amazonBuyBox || snippet || '').slice(0, 120)}"` };
    }
    if (!r.price) {
      await debugDump(page, tag);
      diag.push({ store: s.store, product: job.name, what: 'no price on product page', detail: `${page.url()} · ${await pageSnippet(page)}` });
      return { store: s.store, url: page.url(), status: 'not_found', note: 'Price not found on page' };
    }
    // Amazon: exact per-product savings from its Payment offers panel; the
    // headline "Upto ₹X" cards are only used if the panel can't be read.
    // Amazon: the "Payment offers" panel, else the offer cards on the page. Never
    // Amazon's generic offer text — it mixes in other sellers' and EMI terms.
    let offers;
    if (s.store === 'amazon') {
      const cards = parseAmazonCards(r.text);
      // Signed-out layout ("Save Extra with N offers") first — it is what the scraper
      // normally sees; the signed-in "Payment offers" panel if that is shown instead.
      const sopp = await amazonSoppOffers(page, r.price);
      offers = sopp.offers.length ? sopp.offers : await amazonPanelOffers(page, r.price);
      for (const c of cards) {
        if (!offers.some(o => o.bank === c.bank && o.cardType === c.cardType && o.amount === c.amount && o.offerType === c.offerType)) offers.push(c);
      }
      if (!offers.length && /bank offer|cashback|no cost emi/i.test(r.text)) {
        await debugDump(page, tag + '-offers');
        diag.push({ store: 'amazon', product: job.name, what: 'offers on page but not readable', detail: page.url() });
      }
    } else offers = extractOffers(r.text);
    return {
      store: s.store, url: sd?.url || page.url(), status: 'ok', price: r.price, mrp: r.mrp, inStock: r.inStock,
      title: r.title, priceText: r.priceText, offers,
      note: s.store === 'reliance' && !/store api/.test(r.stockWhy || '') ? `Stock read from the page (${r.stockWhy}) — Reliance's own stock data didn't load`
        : r.ldPrice && Math.abs(r.ldPrice - r.price) > 1 ? `Structured data says ₹${r.ldPrice}` : null,
    };
  } catch (e) {
    await debugDump(page, tag + '-error');
    diag.push({ store: s.store, product: job.name, what: 'error', detail: String(e.message || e).slice(0, 200) });
    return { store: s.store, url: s.url, status: 'error', note: String(e.message || e).slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

// Compare a product's prices across stores: one far below the rest is almost
// always an EMI amount or an accessory (Boombox 3 at ₹641 next to ₹34,999).
function crossCheck(results) {
  const ok = results.filter(r => r.status === 'ok' && r.price > 0);
  if (ok.length < 3) return results;
  const sorted = ok.map(r => r.price).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  for (const r of ok) {
    const ratio = r.price / median;
    if (ratio < 0.4) {
      Object.assign(r, { status: 'not_found', note: `Ignored ₹${r.price} — other stores ~₹${median}, looks like EMI/accessory`, price: null, offers: [] });
    } else if (ratio < 0.65 || ratio > 1.6) {
      r.status = 'suspect';
      r.note = [r.note, `Unusual vs other stores (~₹${median}) — check the listing`].filter(Boolean).join(' · ');
    }
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function runJobs(context, jobs, mode, budget = null) {
  const stats = { ok: 0, blocked: 0, not_listed: 0, not_found: 0, error: 0, skipped: 0 };
  const perStore = {};
  let next = 0;
  const worker = async () => {
    // Past the time limit no new product is started; those in progress finish, and
    // everything already saved stays saved. The products left go first next run.
    while (next < jobs.length && !budget?.expired()) {
      const job = jobs[next++];
      const t = Date.now();
      const stores = job.stores.filter(s => !ONLY.length || ONLY.includes(s.store));
      const results = crossCheck(await Promise.all(stores.map(s => scrapeStore(context, job, s))));
      results.forEach(r => {
        const st = r.skipped ? 'skipped' : r.status;
        if (!r.skipped) breaker.record(r.store, r.status);
        stats[st] = (stats[st] || 0) + 1;  // 'suspect' counts separately
        const ps = (perStore[r.store] ||= {});
        ps[st] = (ps[st] || 0) + 1;
      });
      const line = results.map(r => `${r.store}:${r.status === 'ok' || r.status === 'suspect' ? (r.status === 'suspect' ? '⚠' : '') + '₹' + r.price + (r.offers?.length ? `+${r.offers.length}off` : '') : r.status}`).join('  ');
      console.log(`• ${job.name} (${Math.round((Date.now() - t) / 1000)}s)\n    ${line}`);
      // A store that was skipped has no result to save; if every store was skipped the
      // product is left as it was, so it is tried again at the next run.
      const toSave = results.filter(r => !r.skipped);
      if (!toSave.length) continue;
      try { await api(`/price-watch/bot/results/${job.itemId}?worker=${mode}`, { method: 'POST', body: JSON.stringify({ results: toSave }) }); }
      catch (e) { console.log(`    ! could not save: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, jobs.length) }, worker));
  return { stats, perStore, left: Math.max(0, jobs.length - next) };
}

async function main() {
  const t0 = Date.now();
  const qs = `?limit=${LIMIT}${process.env.QUEUED_ONLY === '1' ? '&queued=1' : ''}&worker=cloud`;
  const jobs = await api('/price-watch/bot/jobs' + qs);
  console.log(`${jobs.length} product(s) to check`);
  if (!jobs.length) return;
  const { browser, context } = await launch();
  // DEADLINE_MIN stops the run cleanly before GitHub kills the job (a killed run
  // reports nothing). 0 or unset = no limit.
  const budget = makeBudget(Number(process.env.DEADLINE_MIN || 0));
  const { stats, perStore, left } = await runJobs(context, jobs, 'cloud', budget);
  await browser.close();
  if (left) {
    console.log(`\nStopped at the time limit after ${budget.elapsedMin()} min: ${left} of ${jobs.length} product(s) are left for the next run.`);
    console.log(`::notice title=time limit::stopped after ${budget.elapsedMin()} min, ${left} of ${jobs.length} products left for the next run`);
  }
  console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s —`, stats);
  report(perStore);
}

// Always-on mode for the showroom PC. Queued products ("Refresh" in the ERP) are
// picked up within ~4 s; when idle it refreshes a few due products at a time.
/** Clear out old debug files left on the PC by earlier versions (and by DEBUG_DUMPS=1). */
function pruneDebugFolder() {
  try {
    const files = fs.readdirSync(DEBUG).filter(n => /\.(png|html)$/i.test(n))
      .map(name => ({ name, mtimeMs: fs.statSync(path.join(DEBUG, name)).mtimeMs }));
    const gone = debugFilesToDelete(files);
    for (const n of gone) fs.rmSync(path.join(DEBUG, n), { force: true });
    if (gone.length) console.log(`Cleared ${gone.length} old debug file(s) from ${DEBUG}`);
  } catch { /* folder missing or locked: nothing to do */ }
}

async function watch() {
  console.log('Price scraper running in watch mode — keep this window open. Ctrl+C to stop.');
  // Below-normal priority: whatever the person at the laptop is doing comes first. The
  // browser it starts inherits this (Windows passes BELOW_NORMAL on to child processes).
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: carry on */ }
  pruneDebugFolder();
  // Only one copy may work at a time (the PC may start it twice): hold a local port as a lock.
  // A second copy no longer exits — that used to stop the scraper for good after an
  // update. It waits on standby and takes over the moment the working copy stops.
  const net = await import('node:net');
  const tryLock = () => new Promise(res => {
    const srv = net.createServer().once('error', () => res(null)).listen(47231, '127.0.0.1', () => { srv.unref(); res(srv); });
  });
  lockServer = await tryLock();
  if (!lockServer) {
    // Older versions restarted themselves by starting this copy and then sitting on the
    // lock while waiting for it — a deadlock. If the copy holding the lock is our own
    // parent scraper, end it so this (newer) copy can work.
    await endParentScraper();
    console.log('Another copy of the price scraper is working — standing by to take over.');
    while (!(lockServer = await tryLock())) await sleep(10_000);
    console.log('Took over as the working copy.');
  }

  let b = null, lastDue = 0, idleSince = Date.now();
  // A browser hiccup (e.g. Playwright's "Unexpected end of JSON input") must not
  // stop the scraper: drop that browser, start a fresh one, carry on with the queue.
  const recover = e => {
    console.log(`! browser problem: ${String(e?.message || e).split('\n')[0]} — restarting browser`);
    const old = b; b = null; old?.browser.close().catch(() => {});
  };
  process.on('uncaughtException', recover);
  process.on('unhandledRejection', recover);
  // Scheduled full refreshes are GitHub's job; the PC only handles ERP refresh
  // clicks unless DUE_EVERY_MIN is set.
  const DUE_EVERY = Number(process.env.DUE_EVERY_MIN || 0) * 60_000;
  let lastUpdateCheck = 0;
  for (;;) {
    // Every 10 minutes (and while idle), pick up a newer version of the scraper from the ERP.
    if (Date.now() - lastUpdateCheck > 10 * 60_000) {
      lastUpdateCheck = Date.now();
      if (await selfUpdate()) {
        if (b) await b.browser.close().catch(() => {});
        await restartSelf();
        return;
      }
    }
    try {
      let jobs = await api('/price-watch/bot/jobs?queued=1&limit=12&worker=local', {}, 2);
      let kind = 'requested';
      if (!jobs.length && DUE_EVERY > 0 && Date.now() - lastDue > DUE_EVERY) {
        jobs = await api('/price-watch/bot/jobs?limit=20&worker=local', {}, 2); kind = 'due'; lastDue = Date.now();
      }
      if (!jobs.length) {
        // Close Chrome 2 idle minutes after the last refresh — nothing runs in between.
        if (b && Date.now() - idleSince > 2 * 60_000) { await b.browser.close().catch(() => {}); b = null; }
        await sleep(4000);
        continue;
      }
      if (!b || !b.browser.isConnected()) b = await launch();
      const t0 = Date.now();
      console.log(`\n${new Date().toLocaleTimeString('en-IN')} — ${jobs.length} ${kind} product(s)`);
      await runJobs(b.context, jobs, 'local');
      console.log(`  done in ${Math.round((Date.now() - t0) / 1000)}s`);
      idleSince = Date.now();
    } catch (e) {
      console.log(`! ${e.message} — retrying in 15 s`);
      if (b && !b.browser.isConnected()) b = null;
      await sleep(15_000);
    }
  }
}

// ── Self-update (showroom PC) ───────────────────────────────────────────────
// Compares this folder's files with the ones on the ERP server and, when they
// differ, writes the new ones and restarts — no one has to copy files by hand.
async function selfUpdate() {
  if (process.env.NO_SELF_UPDATE === '1') return false;
  try {
    const { createHash } = await import('crypto');
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const remote = await api('/price-watch/bot/scraper-version', {}, 1);
    const h = createHash('sha256');
    for (const f of remote.files) { try { h.update(f + '\0' + fs.readFileSync(path.join(dir, f))); } catch { /* missing */ } }
    if (h.digest('hex').slice(0, 16) === remote.version) return false;
    const files = [];
    for (const f of remote.files) files.push(await api(`/price-watch/bot/scraper-file/${f}`, {}, 2));
    for (const f of files) { if (f?.content && f.content.length > 50) fs.writeFileSync(path.join(dir, f.name), f.content); }
    console.log(`\n↻ Scraper updated to version ${remote.version} — restarting…`);
    return true;
  } catch (e) {
    console.log(`(update check skipped: ${String(e?.message || e).slice(0, 80)})`);
    return false;
  }
}

let lockServer = null;

/**
 * Restart into the new files. The lock is released first and this process exits; the
 * background loop on the PC (RUN-BACKGROUND.bat / START-SCRAPER.bat) starts the new
 * version a few seconds later. Run any other way, a fresh copy is started here.
 */
async function restartSelf() {
  try { lockServer?.close(); } catch { /* already closed */ }
  lockServer = null;
  if (process.env.SCRAPER_LOOP === '0') {
    const { spawn } = await import('child_process');
    spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env, detached: true }).unref();
  }
  setTimeout(() => process.exit(0), 300);
}

/** If our parent process is an older scraper waiting on us, end it (Windows and Linux). */
async function endParentScraper() {
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) return;
  try {
    let cmd = '';
    if (process.platform === 'win32') {
      const { execFileSync } = await import('child_process');
      cmd = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`], { encoding: 'utf8', timeout: 15000 });
    } else {
      const fs = await import('fs');
      cmd = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    }
    if (/node/i.test(cmd) && /index\.mjs/i.test(cmd)) {
      console.log('Ending the older scraper copy that started this one…');
      process.kill(ppid);
    }
  } catch { /* can't tell — just stand by */ }
}

/** Per-store results + example failures, as GitHub annotations and a job summary (both public). */
function report(perStore) {
  const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, ' ');
  const g = diag.filter(d => d.store === 'google');
  if (g.length) console.log(`::warning title=google::${esc(g.slice(0, 2).map(d => `[${d.product}] ${d.what}`).join(' || '))}`);
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

export { launch, scrapeStore, readPage, findViaSitemap, crossCheck, runJobs, breaker, debugDump, pruneDebugFolder };
// Run when started directly (`node index.mjs`), not when imported by tests.
// fileURLToPath handles Windows paths ("C:\\…") and spaces correctly.
const isMain = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase(); }
  catch { return false; }
})();
if (isMain && !process.env.SCRAPER_TEST) {
  (WATCH ? watch() : main()).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
