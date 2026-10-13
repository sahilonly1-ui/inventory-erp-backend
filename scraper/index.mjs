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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProductUrl, urlKey, pickBest, titleScore, extractOffers, searchQueries, storeSearchUrl, STORE_DOMAIN, MARKETPLACES, unwrapSearchLink, engineUrls, sitemapLocs, slugText, productSitemaps, googleUrl, isGoogleBlock, parseAmazonPanel } from './lib.mjs';

const API = process.env.API_BASE || 'https://inventory-erp-backend-iplr.onrender.com/api/v1';
const KEY = process.env.AGENT_KEY;
const LIMIT = Number(process.env.LIMIT || 300);
const ONLY = (process.env.STORES || '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG = process.env.DEBUG_DIR || path.resolve('debug');
const WATCH = process.env.WATCH === '1';
// On the showroom PC keep it light: 2 products (≈10 tabs) at a time.
const ITEM_CONCURRENCY = Number(process.env.CONCURRENCY || (WATCH ? 2 : 6));
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
  await sleep(300);
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

// ── Politeness: at most N pages open per store at once ────────────────────
// Bursts of parallel requests are what get a server blocked. Amazon is the
// strictest, so it gets one page at a time with a short gap.
const STORE_SLOTS = WATCH
  ? { amazon: 2, flipkart: 3, croma: 3, reliance: 3, official: 4, engine: 2, google: 1 }   // home connection: Amazon is less strict
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

/** Amazon: open "See all offers & discounts" and read exact savings, both tabs. */
async function amazonPanelOffers(page, price) {
  try {
    const link = page.getByText(/see all offers/i).first();
    if (!(await link.count())) return [];
    await link.click({ timeout: 4000 });
    await page.waitForFunction(() => /PAYMENT OFFERS|Save ₹/i.test(document.body.innerText), null, { timeout: 6000 }).catch(() => {});
    await sleep(800);
    const text = () => page.evaluate(() => document.body.innerText);
    const offers = parseAmazonPanel(await text(), 'Full swipe', price);
    const emiTab = page.getByText(/^EMI plans$/i).first();
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
    // The first price block that actually holds a price (Amazon moves it around).
    const box = [...document.querySelectorAll('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop, #corePrice_desktop, #apex_offerDisplay_desktop, #buybox, #desktop_buybox')]
      .find(b => b.querySelector('.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .a-price .a-offscreen, .a-price-whole, #price_inside_buybox'));
    const pay = box?.querySelector('.priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, #price_inside_buybox, .a-price .a-offscreen');
    const whole = box?.querySelector('.priceToPay .a-price-whole, .a-price-whole');
    const pt = txt(pay) || (whole ? '₹' + txt(whole) : '');
    if (pt) { res.price = num(pt); res.priceText = pt; }
    const mrpEl = box?.querySelector('.basisPrice .a-offscreen, .a-price.a-text-price .a-offscreen');
    if (mrpEl) res.mrp = num(txt(mrpEl));
    // innerText = only what is visible. Amazon keeps hidden "Currently unavailable"
    // templates in the page; textContent would read them.
    const vis = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const av = vis(document.querySelector('#availability')).toLowerCase();
    if (av) res.inStock = !/(currently unavailable|out of stock)/.test(av);
    const shown = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const canBuy = shown(document.querySelector('#add-to-cart-button')) || shown(document.querySelector('#buy-now-button'));
    if (canBuy) res.inStock = true;
    // No buy box ("No featured offers available", "Currently unavailable", only
    // "See All Buying Options"): Amazon isn't selling it right now. Any other ₹
    // on the page belongs to variants, ads or "customers also viewed".
    const buyBox = document.querySelector('#buybox, #desktop_buybox, #rightCol');
    const bbText = vis(buyBox).toLowerCase();
    if (!res.price || (!canBuy && /no featured offers available|currently unavailable/.test(bbText))) {
      if (/no featured offers available|currently unavailable|see all buying options/.test(bbText + ' ' + av)) res.inStock = false;
      res.price = null; res.priceText = null; res.mrp = null;
    }
    res.amazonNoBuyBox = !res.price;
  }

  // Generic: the biggest, un-struck rupee amount near the top of the page is
  // the selling price; a struck-through larger one next to it is the M.R.P.
  if (!res.price && store !== 'amazon') {
    const cands = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 2) continue;
      const t = txt(el);
      if (!/^(₹|rs\.?)\s?[\d,]+(\.\d{1,2})?$/i.test(t)) continue;
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
    const buyable = btns.some(b => !b.off && /^(add to cart|buy now|add to bag|buy)$/.test(b.t));
    const notifyBtn = btns.some(b => /^(notify me|notify when available)$/.test(b.t));
    const unavailable = notifyBtn || /(currently unavailable|out of stock|sold out|coming soon)/.test(head);
    if (unavailable && !buyable) res.inStock = false;
    else if (res.inStock === null && buyable) res.inStock = true;
  }
  // Text above the recommendation rails holds the offers; keep it bounded.
  res.text = (railsAt > 0 ? body.slice(0, railsAt) : body).slice(0, 60_000);
  return res;
}

async function scrapeStore(context, job, s) {
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
      // 1. Google (shared by all stores of this product — one search, not five).
      // A retry after a wrong saved page searches Google again just for this store.
      const g = s._retried ? await googleDiscover(context, job, [s]) : await (job._google ||= googleDiscover(context, job, job.stores));
      if (g[s.store]) url = g[s.store];
      else if (Date.now() < googleBlockedUntil) why += 'google: paused (captcha); ';
      else why += 'google: no match; ';
      // When Google answered properly and still didn't show this store, the
      // product is most likely not sold there: one quick store search, no more.
      const quick = job._googleOk && !url;
      // 2. Brand sites: the sitemap — no search page, no bot checks.
      if (!url && s.store === 'official') {
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
        const blockedAll = /blocked/.test(why) && !/links/.test(why);
        diag.push({ store: s.store, product: job.name, what: blockedAll ? 'search blocked' : 'not found in search', detail: `${why} · ${await pageSnippet(page)}` });
        return blockedAll ? { store: s.store, status: 'blocked', note: why.trim().slice(0, 200) } : { store: s.store, status: 'not_listed' };
      }
    }
    const load = () => withSlot(s.store, async () => {
      await open(page, url);
      if (s.store === 'amazon') await passInterstitial(page, url);
      return isBlocked(page);
    });
    let blocked = await load();
    if (blocked) { await sleep(4000 + Math.random() * 3000); blocked = await load(); } // one polite retry
    if (blocked) {
      await debugDump(page, tag);
      diag.push({ store: s.store, product: job.name, what: `product page blocked (${blocked})`, detail: await pageSnippet(page) });
      return { store: s.store, url, status: 'blocked', note: blocked };
    }
    await expandOffers(page, s.store);
    const r = await page.evaluate(readPage, s.store);
    // Is this page really our product? A link saved earlier (or picked from a
    // search) can point at a sibling model — SB550 for SB590, SB180 for Bar 2.1
    // Essential. A link the admin pasted is trusted as is.
    const wanted = [job.name, job.variant].filter(Boolean).join(' ');
    if (!s.locked && r.title && titleScore(wanted, job.brand, r.title) < 0.55) {
      diag.push({ store: s.store, product: job.name, what: 'page is a different product', detail: `${r.title.slice(0, 80)} · ${page.url()}` });
      if (s.url && !s._retried) {
        await page.close().catch(() => {});
        return scrapeStore(context, job, { ...s, url: null, _retried: true, _bad: page.url() });
      }
      return { store: s.store, status: 'not_listed', note: `Closest page was a different product: ${r.title.slice(0, 80)}` };
    }
    if (!r.price && r.amazonNoBuyBox) {
      return { store: s.store, url: page.url(), status: 'not_found', inStock: false, title: r.title, note: 'Not sold on Amazon right now (no featured offer / unavailable)' };
    }
    if (!r.price) {
      await debugDump(page, tag);
      diag.push({ store: s.store, product: job.name, what: 'no price on product page', detail: `${page.url()} · ${await pageSnippet(page)}` });
      return { store: s.store, url: page.url(), status: 'not_found', note: 'Price not found on page' };
    }
    // Amazon: exact per-product savings from its Payment offers panel; the
    // headline "Upto ₹X" cards are only used if the panel can't be read.
    const panel = s.store === 'amazon' ? await amazonPanelOffers(page, r.price) : [];
    const offers = panel.length ? panel : extractOffers(r.text);
    return {
      store: s.store, url: page.url(), status: 'ok', price: r.price, mrp: r.mrp, inStock: r.inStock,
      title: r.title, priceText: r.priceText, offers,
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
async function runJobs(context, jobs, mode) {
  const stats = { ok: 0, blocked: 0, not_listed: 0, not_found: 0, error: 0 };
  const perStore = {};
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t = Date.now();
      const stores = job.stores.filter(s => !ONLY.length || ONLY.includes(s.store));
      const results = crossCheck(await Promise.all(stores.map(s => scrapeStore(context, job, s))));
      results.forEach(r => {
        stats[r.status] = (stats[r.status] || 0) + 1;  // 'suspect' counts separately
        const ps = (perStore[r.store] ||= {});
        ps[r.status] = (ps[r.status] || 0) + 1;
      });
      const line = results.map(r => `${r.store}:${r.status === 'ok' || r.status === 'suspect' ? (r.status === 'suspect' ? '⚠' : '') + '₹' + r.price + (r.offers?.length ? `+${r.offers.length}off` : '') : r.status}`).join('  ');
      console.log(`• ${job.name} (${Math.round((Date.now() - t) / 1000)}s)\n    ${line}`);
      try { await api(`/price-watch/bot/results/${job.itemId}?worker=${mode}`, { method: 'POST', body: JSON.stringify({ results }) }); }
      catch (e) { console.log(`    ! could not save: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, jobs.length) }, worker));
  return { stats, perStore };
}

async function main() {
  const t0 = Date.now();
  const qs = `?limit=${LIMIT}${process.env.QUEUED_ONLY === '1' ? '&queued=1' : ''}&worker=cloud`;
  const jobs = await api('/price-watch/bot/jobs' + qs);
  console.log(`${jobs.length} product(s) to check`);
  if (!jobs.length) return;
  const { browser, context } = await launch();
  const { stats, perStore } = await runJobs(context, jobs, 'cloud');
  await browser.close();
  console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s —`, stats);
  report(perStore);
}

// Always-on mode for the showroom PC. Queued products ("Refresh" in the ERP) are
// picked up within ~4 s; when idle it refreshes a few due products at a time.
async function watch() {
  console.log('Price scraper running in watch mode — keep this window open. Ctrl+C to stop.');
  // Only one copy may run (the PC may start it twice): hold a local port as a lock.
  const net = await import('node:net');
  const locked = await new Promise(res => {
    const srv = net.createServer().once('error', () => res(false)).listen(47231, '127.0.0.1', () => res(true));
    srv.unref();
  });
  if (!locked) { console.log('Another copy of the price scraper is already running — exiting.'); process.exit(0); }

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
  for (;;) {
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

export { launch, scrapeStore, readPage, findViaSitemap, crossCheck };
// Run when started directly (`node index.mjs`), not when imported by tests.
// fileURLToPath handles Windows paths ("C:\\…") and spaces correctly.
const isMain = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase(); }
  catch { return false; }
})();
if (isMain && !process.env.SCRAPER_TEST) {
  (WATCH ? watch() : main()).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
