// Pure helpers for the price scraper — no browser, unit-tested in lib.test.mjs.

// ── Store URL rules (mirror src/modules/pricewatch/stores.ts) ──────────────
export const PRODUCT_URL = {
  amazon: u => /\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(u.pathname) && /amazon\.in$/.test(u.hostname),
  flipkart: u => /\/p\/itm[a-z0-9]+/i.test(u.pathname) && /flipkart\.com$/.test(u.hostname),
  croma: u => /\/p\/\d+/.test(u.pathname) && /croma\.com$/.test(u.hostname),
  reliance: u => /reliancedigital\.in$/.test(u.hostname) && u.pathname.length > 10
    && !/^\/(search|products|collection|c|brand|cart|login|offers?)\b/i.test(u.pathname)
    && (/\/p\/|\/product\/|-\d{5,}/.test(u.pathname)),
  official: u => u.pathname.length > 3,
};
export function isProductUrl(store, href) {
  try { return !!PRODUCT_URL[store]?.(new URL(href)); } catch { return false; }
}
/** One key per product page, so duplicate links on a search page collapse. */
export function urlKey(store, href) {
  try {
    const u = new URL(href);
    if (store === 'amazon') return u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? href;
    if (store === 'flipkart') return u.pathname.match(/\/p\/(itm[a-z0-9]+)/i)?.[1] ?? href;
    return u.hostname + u.pathname.replace(/\/+$/, '');
  } catch { return href; }
}

// ── Matching a search result to our product ────────────────────────────────
// Words that describe a category, not a model — they never decide a match.
const GENERIC = new Set(['soundbar', 'sound', 'subwoofer', 'woofer', 'channel', 'dolby', 'atmos', 'home', 'theatre', 'theater', 'surround',
  'speakers', 'earbuds', 'earphones', 'headphones', 'headphone', 'tws', 'true', 'smart', 'watch', 'smartwatch', 'tv', 'led', 'oled', 'qled',
  'inch', 'inches', 'cm', 'display', 'deep', 'bass', 'stereo', 'audio', 'music', 'waterproof', 'ultra', 'portable', 'party', 'karaoke',
  'microphone', 'mic', 'mics', 'noise', 'cancelling', 'canceling', 'anc', 'hdmi', 'earc', 'optical', 'bluetooth', 'wireless', 'wired', 'mobile', 'tablet',
  '5g', '4g', 'dual', 'sim', 'ram', 'rom', 'storage', 'memory', 'eco']);
const STOP = new Set(['with', 'and', 'the', 'for', 'of', 'in', 'by', 'new', 'latest', 'edition', 'version', 'speaker', 'speakers',
  'portable', 'bluetooth', 'wireless', 'wifi', 'wi', 'fi', 'smartphone', 'mobile', 'phone', 'android', 'india', 'black', 'white',
  'blue', 'grey', 'gray', 'red', 'green', 'silver', 'gold', 'party', 'box']);
// Always an accessory listing:
const ACCESSORY_STRONG = /\b(tempered|screen guard|protector|replacement|sticker|decal|skin|compatible with|compatible for)\b/i;
// Accessory words that also appear in real product titles ("…with Alexa Voice
// Remote", "…with charger") — only an accessory when it is "X for <product>".
const ACCESSORY = /\b(case|cover|pouch|strap|band|charger|adapter|adaptor|cable|bag|sleeve|stand|mount|holder|remote|refill|spare|carry)\b[^,]{0,40}\bfor\b/i;
const NOT_NEW = /\b(renewed|refurbished|pre-?owned|used|open box)\b/i;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = s => norm(s).split(' ').filter(Boolean);

/**
 * 0..1 — how well a listing title matches our product name. Any token with a
 * digit (model numbers: "120", "s26", "160w") must appear exactly, and the
 * brand must appear, otherwise 0: a PartyBox 110 is never a PartyBox 120.
 */
// Spec tokens ("160w", "5000mah", "120hz") are often left out of listing titles,
// so they don't decide a match. Model numbers ("120", "s26", "3rd") and storage
// ("256gb") do.
const SPEC = /^\d+(w|watt|watts|mah|hz|mm|cm|inch|in|v|a|h|hr|hrs|hours|k)$/;

export function titleScore(name, brand, candidate) {
  // Bracketed extras in ERP names — SKU codes "(JBLCLIP5SQUAD)", colours
  // "(Black)" — aren't in store titles, so they don't count. Storage/RAM in
  // brackets "(8GB/256GB)" does.
  name = String(name).replace(/\(([^)]*)\)/g, (m, inner) => (/\d+\s?(gb|tb)\b/i.test(inner) ? ` ${inner} ` : ' '));
  const cand = norm(candidate);
  if (!cand) return 0;
  const squashed = cand.replace(/ /g, '');
  const nameN = norm(name);
  if ((ACCESSORY_STRONG.test(cand) && !ACCESSORY_STRONG.test(nameN)) || (ACCESSORY.test(cand) && !ACCESSORY.test(nameN))) return 0;
  if (NOT_NEW.test(cand)) return 0;
  if (brand && !squashed.includes(norm(brand).replace(/ /g, ''))) return 0;

  // "2.1", "5.1", "3.1.2" (channels) are specs, not model numbers.
  const nameNoChannels = String(name).replace(/\b\d(\.\d){1,2}\b(\s*(ch|channel))?/gi, ' ');
  const candTokensAll = tokens(cand);
  const all = tokens(nameNoChannels);
  const has = t => new RegExp(`(^|[^0-9])${t}(?![0-9])`).test(cand) || new RegExp(`(^|[^0-9])${t}(?![0-9])`).test(squashed);
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (!/\d/.test(t) || SPEC.test(t)) continue;
    if (!has(t)) return 0;                       // model number must match exactly
    // …and so must the word naming the line right before it: "Club 120" is not
    // "PartyBox 120", "Encore 2" is not "Flip 2". Generic words are skipped.
    const prev = all[i - 1];
    if (prev && !/\d/.test(prev) && !STOP.has(prev) && prev.length > 1 && !squashed.includes(prev)) return 0;
  }
  // A model variant we didn't ask for ("S26 Ultra", "Clip 5 Pro") — but not when
  // it is part of a hyphenated adjective ("Ultra-Portable", "Max-Bass").
  // Only counts next to the model number ("S26 Ultra", "Clip 5 Pro", "Encore
  // Essential 2") — "Superior Pro Sound" further along the title is just marketing.
  const rawToks = String(candidate).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
  const modelNums = all.filter(t => /\d/.test(t) && !SPEC.test(t));
  const numAt = rawToks.map((t, i) => (modelNums.some(n => t === n || t.endsWith(n)) ? i : -1)).filter(i => i >= 0);
  for (const v of ['pro', 'ultra', 'max', 'plus', 'lite', 'mini', 'fe', 'neo', 'essential', 'go', 'air', 'prime', 'club', 'encore']) {
    if (all.includes(v)) continue;
    const near = numAt.length
      ? rawToks.some((t, i) => t === v && numAt.some(d => i >= d - 1 && i <= d + 2))
      : rawToks.includes(v);
    if (near) return 0;
  }
  // Distinctive words ("Essential", "Cinema", "Bar", "Boombox") identify the model:
  // all must be present (one may be missing/misspelt when the name has 3 or more).
  const brandN = norm(brand || '').replace(/ /g, '');
  const distinctive = [...new Set(all.filter(t => !/\d/.test(t) && !isGenericWord(t) && t.length > 2 && t !== brandN))];
  const missing = distinctive.filter(w => !wordFound(w, candTokensAll, squashed)).length;
  if (missing > (distinctive.length >= 3 ? 1 : 0)) return 0;
  const words = all.filter(t => (!/\d/.test(t) || SPEC.test(t)) && !STOP.has(t) && t.length > 1);
  const hit = words.length ? words.filter(w => wordFound(w, candTokensAll, squashed)).length / words.length : 1;
  // Tie-break only: a listing full of words our name doesn't have is less likely to be it.
  const candWords = tokens(candidate).filter(t => !/\d/.test(t) && !STOP.has(t) && t.length > 1);
  const extra = candWords.length ? candWords.filter(w => !nameN.replace(/ /g, '').includes(w)).length / candWords.length : 0;
  return Math.max(0, 0.5 + 0.5 * hit - 0.15 * extra);
}

export function pickBest(name, brand, candidates, min = 0.55) {
  let best = null;
  for (const c of candidates) {
    const s = titleScore(name, brand, c.text);
    if (s >= min && (!best || s > best.score)) best = { ...c, score: s };
  }
  return best;
}

// ── Prices ─────────────────────────────────────────────────────────────────
export function toNumber(text) {
  const m = String(text ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// ── Offers ─────────────────────────────────────────────────────────────────
const BANKS = [
  // Co-branded cards first, so "Flipkart Axis" isn't reported as plain Axis.
  ['Amazon Pay ICICI', /amazon pay icici/i], ['Flipkart Axis', /flipkart axis/i], ['Flipkart SBI', /flipkart sbi/i],
  ['Swiggy HDFC', /swiggy hdfc/i], ['Tata Neu HDFC', /tata neu/i], ['Airtel Axis', /airtel axis/i],
  ['HDFC Bank', /\bhdfc\b/i], ['ICICI Bank', /\bicici\b/i], ['SBI Card', /\bsbi\b/i], ['Axis Bank', /\baxis\b/i],
  ['Kotak', /\bkotak\b/i], ['IDFC FIRST Bank', /\bidfc\b/i], ['OneCard', /\bone ?card\b/i], ['Federal Bank', /\bfederal\b/i],
  ['RBL Bank', /\brbl\b/i], ['Bank of Baroda', /\b(bob ?card|bank of baroda|bob)\b/i], ['AU Bank', /\bau (small|bank)\b/i],
  ['Yes Bank', /\byes bank\b/i], ['IndusInd Bank', /\bindusind\b/i], ['American Express', /\b(amex|american express)\b/i],
  ['HSBC', /\bhsbc\b/i], ['Standard Chartered', /\bstandard chartered\b/i], ['DBS Bank', /\bdbs\b/i], ['Citi', /\bciti\b/i],
  ['Canara Bank', /\bcanara\b/i], ['PNB', /\b(pnb|punjab national)\b/i], ['Union Bank', /\bunion bank\b/i],
  ['Paytm', /\bpaytm\b/i],
  ['BHIM UPI', /\bbhim\b/i], ['Bajaj Finserv', /\bbajaj\b/i], ['Jio Finance', /\bjio ?finance\b/i],
];
const OFFER_HINT = /(bank offer|cashback|instant discount|no cost emi|\bemi\b|credit card|debit card|\b(off|discount)\b.*(card|bank)|(card|bank).*\b(off|discount)\b)/i;
const RUPEE = /(?:₹|\brs\.?(?=\s?\d)|\binr(?=\s?\d))\s?([\d,]+(?:\.\d+)?)/gi;

/** Picks out offer sentences from page text, joining a short line with its neighbours. */
export function offerBlocks(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  lines.forEach((l, i) => {
    if (l.length > 400 || !OFFER_HINT.test(l)) return;
    let block = l;
    // A card often splits "Bank Offer" / "Upto ₹1,500 off on HDFC…" over two or
    // three lines. A line that already names a bank and an amount stands alone,
    // so it never swallows the next card's heading ("Cashback").
    const complete = /\d/.test(l) && BANKS.some(([, re]) => re.test(l));
    if (!complete && lines[i + 1]) block += ' ' + lines[i + 1];
    if (!/\d/.test(block) && lines[i + 2]) block += ' ' + lines[i + 2];
    out.push(block.slice(0, 400));
  });
  return [...new Set(out)];
}

export function parseOffer(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const bank = BANKS.find(([, re]) => re.test(t))?.[0] ?? null;
  const lower = t.toLowerCase();

  let offerType = 'other';
  if (/no cost emi/.test(lower)) offerType = 'no_cost_emi';
  else if (/cashback/.test(lower)) offerType = 'cashback';
  else if (/exchange/.test(lower) && !bank) offerType = 'exchange';
  else if (/coupon/.test(lower) && !bank) offerType = 'coupon';
  else if (/(discount|\boff\b|save)/.test(lower)) offerType = 'instant_discount';

  const credit = /credit/.test(lower), debit = /debit/.test(lower);
  const cardType = credit && debit ? 'Credit & Debit' : credit ? 'Credit Card' : debit ? 'Debit Card' : /\bupi\b/.test(lower) ? 'UPI' : null;
  const emi = /\bemi\b/.test(lower) && offerType !== 'no_cost_emi';
  const nonEmi = /(non[- ]?emi|full swipe|one[- ]?time|without emi)/.test(lower);
  const mode = emi && nonEmi ? 'EMI & Full swipe' : nonEmi ? 'Full swipe' : emi ? (/(emi and non|emi & non|emi\/non)/.test(lower) ? 'EMI & Full swipe' : 'EMI') : null;

  const pcts = [...t.matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map(m => Number(m[1]));
  // "5% back for Prime members, 3% for others": count what every customer gets.
  const percent = !pcts.length ? null : (/prime/i.test(t) && pcts.length > 1 ? Math.min(...pcts) : pcts[0]);
  // Amounts "per month" are EMI instalments, never a saving.
  const rupees = [...t.matchAll(RUPEE)]
    .filter(m => !/^\s*(\/-)?\s*(\/\s?m(o|onth)?\b|per month|p\.?m\.?\b|x\s?\d+\s?m)/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 16)))
    .map(m => ({ v: Number(m[1].replace(/,/g, '')), at: m.index }));
  const minM = t.match(/(?:\bmin(?:imum)?\.?(?:\s*(?:txn|transaction|purchase|order|cart))?(?:\s*(?:value|amount))?(?:\s*of)?|(?:orders?|purchases?|transactions?|txns?)\s*(?:value\s*)?(?:of|above|over|worth)|above)\s*:?\s*(?:₹|rs\.?|inr)?\s?([\d,]+)/i);
  const minTxn = minM ? Number(minM[1].replace(/,/g, '')) : null;
  const upTo = t.match(/(?:up\s?to|upto|\bmax(?:imum)?(?: discount| cashback)?(?: of)?)\s*(?:₹|\brs\.?|\binr)\s?([\d,]+)/i);
  let maxDiscount = upTo ? Number(upTo[1].replace(/,/g, '')) : null;

  let amount = null;
  const others = rupees.map(r => r.v).filter(v => v !== minTxn);
  if (percent === null) {
    // "Upto ₹3,000 discount on SBI cards" is the offer's ceiling across all
    // products, not what this product gets — keep it as a cap only, never as
    // the saving. A flat "₹2,000 off" (no "upto") is a real amount.
    if (maxDiscount) amount = null;
    else amount = others[0] ?? null;
  } else if (!maxDiscount && others.length) maxDiscount = others[0];

  // No-cost EMI is a facility, not a discount — unless it states the interest saved.
  if (offerType === 'no_cost_emi' && !/(saving|save)/i.test(t)) { amount = null; maxDiscount = null; }
  return {
    bank, cardType, offerType, mode, amount, percent, maxDiscount, minTxn,
    summary: t.replace(/\b(T&C|Know more|View plans?|Details)\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 250),
  };
}

/** Text → structured offers, de-duplicated, only real bank/payment offers. */
export function extractOffers(text) {
  const seen = new Set(); const out = [];
  for (const b of offerBlocks(text)) {
    const o = parseOffer(b);
    if (!o.bank && !['cashback', 'no_cost_emi'].includes(o.offerType)) continue;
    if (!o.amount && !o.percent && !o.maxDiscount && o.offerType !== 'no_cost_emi') continue;
    const key = [o.bank, o.offerType, o.amount, o.percent, o.maxDiscount, o.cardType].join('|');
    if (seen.has(key)) continue;
    seen.add(key); out.push(o);
  }
  return out.slice(0, 20);
}

// ── Search queries & URLs ─────────────────────────────────────────────────
const FLUFF = /\b(portable|bluetooth|wireless|wifi|wi-fi|speaker|speakers|party speaker|with|and|the|for|smartphone|mobile|phone|true|earbuds?)\b/gi;
/** Two queries: a cleaned full name, then just brand + model up to the model number. */
export function searchQueries(name, brand, variant) {
  const base = String(name).replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  const clean = base.replace(FLUFF, ' ').replace(/\s+/g, ' ').trim();
  const words = base.split(' ');
  const firstNum = words.findIndex(w => /\d/.test(w));
  const short = firstNum >= 0 ? words.slice(0, firstNum + 1).join(' ') : clean;
  const withBrand = q => (brand && !q.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${q}` : q);
  const qs = [withBrand([clean, variant].filter(Boolean).join(' ')), withBrand(short)];
  return [...new Set(qs.map(q => q.trim()).filter(Boolean))];
}

// Brand sites whose search isn't at /search?q=
const BRAND_SEARCH = {
  'samsung.com': q => `https://www.samsung.com/in/search/?searchvalue=${q}`,
  'apple.com': q => `https://www.apple.com/in/search/${q}?src=globalnav`,
  'oneplus.in': q => `https://www.oneplus.in/search?keyword=${q}`,
  'mi.com': q => `https://www.mi.com/in/search/${q}`,
  'boat-lifestyle.com': q => `https://www.boat-lifestyle.com/search?q=${q}`,
  'sony.co.in': q => `https://www.sony.co.in/search?query=${q}`,
  'shopatsc.com': q => `https://shopatsc.com/search?q=${q}`,
};

export function storeSearchUrl(store, query, officialSite) {
  const q = encodeURIComponent(query);
  switch (store) {
    case 'amazon': return `https://www.amazon.in/s?k=${q}`;
    case 'flipkart': return `https://www.flipkart.com/search?q=${q}`;
    case 'croma': return `https://www.croma.com/searchB?q=${q}%3Arelevance&text=${q}`;
    case 'reliance': return `https://www.reliancedigital.in/products?q=${q}`;
    case 'official': {
      if (!officialSite) return null;
      const f = BRAND_SEARCH[officialSite];
      return f ? f(q) : `https://${officialSite}/search?q=${q}`;
    }
  }
  return null;
}

// ── Web search engines as a fallback way to find product pages ─────────────
export const STORE_DOMAIN = { amazon: 'amazon.in', flipkart: 'flipkart.com', croma: 'croma.com', reliance: 'reliancedigital.in' };
/** Marketplaces are never a brand's "official site" (Amazon devices → amazon.in). */
export const MARKETPLACES = ['amazon.in', 'amazon.com', 'flipkart.com', 'croma.com', 'reliancedigital.in'];

/** Bing / DuckDuckGo wrap result links; return the real target URL. */
export function unwrapSearchLink(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/a')) {
      const v = u.searchParams.get('u');
      if (v && v.startsWith('a1')) return Buffer.from(v.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
    if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg')) return decodeURIComponent(u.searchParams.get('uddg'));
    // Google: /url?q=<target>&… (older markup) — current markup links directly.
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url') || href;
    // Yahoo: https://r.search.yahoo.com/_ylt=…/RU=<encoded url>/RK=2/RS=…
    const ru = u.pathname.match(/\/RU=([^/]+)\/RK=/);
    if (/yahoo\.com$/.test(u.hostname) && ru) return decodeURIComponent(ru[1]);
    return u.toString();
  } catch { return href; }
}
export function engineUrls(domain, query) {
  const q = encodeURIComponent(`site:${domain} ${query}`);
  return [
    `https://www.bing.com/search?q=${q}&setlang=en-IN&cc=IN`,
    `https://in.search.yahoo.com/search?p=${q}`,
    `https://search.brave.com/search?q=${q}&source=web`,
    `https://html.duckduckgo.com/html/?q=${q}&kl=in-en`,
  ];
}

// ── Brand sitemaps ─────────────────────────────────────────────────────────
/** <loc> URLs from a sitemap or sitemap index. */
export function sitemapLocs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
}
/** Words in a product URL's slug, for matching against our product name. */
export function slugText(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname).replace(/\.(html?|aspx?)$/i, '').replace(/[\/_\-+.]+/g, ' ').trim();
  } catch { return ''; }
}
/** Child sitemaps likely to hold products (skip blogs, pages, images). */
export function productSitemaps(locs) {
  const xmls = locs.filter(l => /\.xml(\.gz)?(\?|$)/i.test(l) && !/\.gz/i.test(l));
  const prod = xmls.filter(l => /product/i.test(l));
  return (prod.length ? prod : xmls.filter(l => !/(blog|page|post|image|video|categor|collection|article|store-?locator)/i.test(l))).slice(0, 12);
}

// ── Google: one search finds the product on every store at once ───────────
export function googleUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=in&num=20&pws=0`;
}
/** Google's "unusual traffic" wall. */
export function isGoogleBlock(url, text) {
  return /google\.[a-z.]+\/sorry\//i.test(url) || /unusual traffic from your computer|not a robot/i.test(text || '');
}

// ── Amazon "Payment offers" panel ─────────────────────────────────────────
// Amazon works out the exact saving for this product ("Save ₹1,750 · SBI Credit
// Card") in the panel behind "See all offers & discounts". Those numbers are
// what a customer gets, unlike the "Upto ₹3,000" headline on the offer card.
export function parseAmazonPanel(text, mode, price) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^Save ₹\s?([\d,]+)(?:\.\d+)?( as cashback)?$/i);
    if (!m) continue;
    // The next line must name a payment method; tab headers ("EMI plans") and
    // hints ("Select card at checkout…") are skipped.
    const card = lines[i + 1];
    if (!card || !/(card|upi|bank|wallet|net ?banking|pay later)/i.test(card) || /select card|checkout|emi plans|full payment/i.test(card)) continue;
    const amount = Number(m[1].replace(/,/g, ''));
    const bank = BANKS.find(([, re]) => re.test(card))?.[0] ?? (/upi/i.test(card) ? 'UPI' : card.slice(0, 40));
    const low = card.toLowerCase();
    const cardType = /credit/.test(low) && /debit/.test(low) ? 'Credit & Debit' : /credit/.test(low) ? 'Credit Card' : /debit/.test(low) ? 'Debit Card' : /upi/.test(low) ? 'UPI' : null;
    out.push({ bank, cardType, offerType: m[2] ? 'cashback' : 'instant_discount', mode, amount, percent: null, maxDiscount: null, minTxn: null,
      summary: `Save ₹${amount.toLocaleString('en-IN')}${m[2] ? ' as cashback' : ''} with ${card}${mode === 'EMI' ? ' on EMI' : ''}` });
    // "Save ₹1,000 extra on orders above ₹39,990" under the same card
    for (const l of lines.slice(i + 2, i + 7)) {
      if (/^Save ₹\s?[\d,]+(?:\.\d+)?( as cashback)?$/i.test(l)) break;   // next card's block
      const x = l.match(/^Save ₹\s?([\d,]+) extra on orders above ₹\s?([\d,]+)/i);
      if (!x) continue;
      const minTxn = Number(x[2].replace(/,/g, ''));
      if (!price || price >= minTxn) {
        out.push({ bank, cardType, offerType: 'instant_discount', mode, amount: Number(x[1].replace(/,/g, '')), percent: null, maxDiscount: null, minTxn,
          summary: `Extra ₹${x[1]} with ${card} on orders above ₹${x[2]}` });
      }
      break;
    }
  }
  const seen = new Set();
  return out.filter(o => { const k = [o.bank, o.cardType, o.offerType, o.amount, o.mode].join('|'); return seen.has(k) ? false : seen.add(k); });
}

// ── Typo-tolerant word match ("Speakar" ~ "speaker", "Soundber" ~ "soundbar") ──
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function wordFound(word, candTokens, squashed) {
  if (squashed.includes(word)) return true;
  const tol = word.length >= 7 ? 2 : word.length >= 5 ? 1 : 0;
  return tol > 0 && candTokens.some(t => editDistance(word, t) <= tol);
}

/** A category word, or a misspelling of one ("Speakar", "Soundber"). */
function isGenericWord(w) {
  if (STOP.has(w) || GENERIC.has(w)) return true;
  if (w.length < 5) return false;
  const tol = w.length >= 7 ? 2 : 1;
  for (const g of [...STOP, ...GENERIC]) if (g.length >= 5 && editDistance(w, g) <= tol) return true;
  return false;
}

// ── Amazon offer cards on the product page (no click needed) ───────────────
// "Buy for ₹43,749 / SBI Credit Card / -₹3,250"            → full-swipe saving
// "No Cost EMI ₹3,583 x 12m / SBI Credit Card / -₹4,000"   → EMI saving
// "Buy for ₹34,999 + cashback / Amazon Pay ICICI Bank Credit Card / ₹1,049" → cashback
export function parseAmazonCards(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const buy = lines[i].match(/^(?:or\s+)?buy for ₹\s?[\d,]+(?:\.\d+)?(\s*\+\s*cashback)?/i);
    const emi = lines[i].match(/^no cost emi\b/i);
    if (!buy && !emi) continue;
    const block = lines.slice(i + 1, i + 5);
    const cardIdx = block.findIndex(l => /(card|upi|bank)/i.test(l) && !/^(buy for|no cost emi)/i.test(l));
    if (cardIdx < 0) continue;
    let card = block[cardIdx];
    let amt = card.match(/[-–]\s?₹\s?([\d,]+)\s*$/) || card.match(/₹\s?([\d,]+)\s*$/);
    if (amt) card = card.slice(0, amt.index).trim();
    else {
      const next = block[cardIdx + 1] || '';
      amt = next.match(/^[-–]?\s?₹\s?([\d,]+)(?:\.\d+)?$/);
    }
    if (!amt) continue;
    const amount = Number(amt[1].replace(/,/g, ''));
    const bank = BANKS.find(([, re]) => re.test(card))?.[0] ?? (/upi/i.test(card) ? 'UPI' : card.slice(0, 40));
    const low = card.toLowerCase();
    const cardType = /credit/.test(low) && /debit/.test(low) ? 'Credit & Debit' : /credit/.test(low) ? 'Credit Card' : /debit/.test(low) ? 'Debit Card' : /upi/.test(low) ? 'UPI' : null;
    const cashback = !!(buy && buy[1]);
    out.push({ bank, cardType, offerType: cashback ? 'cashback' : 'instant_discount', mode: emi ? 'EMI' : 'Full swipe',
      amount, percent: null, maxDiscount: null, minTxn: null,
      summary: `${cashback ? 'Cashback' : 'Save'} ₹${amount.toLocaleString('en-IN')} with ${card}${emi ? ' on No Cost EMI' : ''}` });
  }
  const seen = new Set();
  return out.filter(o => { const k = [o.bank, o.cardType, o.offerType, o.amount, o.mode].join('|'); return seen.has(k) ? false : seen.add(k); });
}
