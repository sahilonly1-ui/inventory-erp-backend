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
const STOP = new Set(['with', 'and', 'the', 'for', 'of', 'in', 'by', 'new', 'latest', 'edition', 'version', 'speaker', 'speakers',
  'portable', 'bluetooth', 'wireless', 'wifi', 'wi', 'fi', 'smartphone', 'mobile', 'phone', 'android', 'india', 'black', 'white',
  'blue', 'grey', 'gray', 'red', 'green', 'silver', 'gold', 'party', 'box']);
const ACCESSORY = /\b(case|cover|pouch|strap|band|skin|tempered|glass|screen guard|protector|charger|adapter|cable|bag|sleeve|stand|mount|holder|remote|refill|replacement|spare|sticker|decal)\b/i;
const NOT_NEW = /\b(renewed|refurbished|pre-?owned|used|open box)\b/i;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = s => norm(s).split(' ').filter(Boolean);

/**
 * 0..1 — how well a listing title matches our product name. Any token with a
 * digit (model numbers: "120", "s26", "160w") must appear exactly, and the
 * brand must appear, otherwise 0: a PartyBox 110 is never a PartyBox 120.
 */
export function titleScore(name, brand, candidate) {
  const cand = norm(candidate);
  if (!cand) return 0;
  const squashed = cand.replace(/ /g, '');
  if (ACCESSORY.test(cand) && !ACCESSORY.test(norm(name))) return 0;
  if (NOT_NEW.test(cand)) return 0;
  if (brand && !squashed.includes(norm(brand).replace(/ /g, ''))) return 0;

  const all = tokens(name);
  const digitTokens = all.filter(t => /\d/.test(t));
  for (const t of digitTokens) {
    // "110" must not match inside "1100"; "s26" not inside "s26ultra" is fine only if the name says ultra too.
    const re = new RegExp(`(^|[^0-9])${t}(?![0-9])`);
    if (!re.test(cand) && !re.test(squashed)) return 0;
  }
  // A listing that names an extra model variant we didn't ask for ("Pro", "Ultra", "Max", "Plus", "Lite").
  for (const v of ['pro', 'ultra', 'max', 'plus', 'lite', 'mini', 'fe', 'neo', 'essential', 'go', 'air', 'prime']) {
    if (tokens(candidate).includes(v) && !all.includes(v)) return 0;
  }
  const words = all.filter(t => !/\d/.test(t) && !STOP.has(t) && t.length > 1);
  if (!words.length) return digitTokens.length ? 1 : 0;
  const hit = words.filter(w => squashed.includes(w)).length;
  // Tie-break: a listing full of words our name doesn't have is less likely to be it.
  const nameSquashed = norm(name).replace(/ /g, '');
  const candWords = tokens(candidate).filter(t => !/\d/.test(t) && !STOP.has(t) && t.length > 1);
  const extra = candWords.length ? candWords.filter(w => !nameSquashed.includes(w)).length / candWords.length : 0;
  return Math.max(0, hit / words.length - 0.3 * extra);
}

export function pickBest(name, brand, candidates, min = 0.5) {
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
const RUPEE = /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d+)?)/gi;

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

  const pct = t.match(/(\d+(?:\.\d+)?)\s?%/);
  const percent = pct ? Number(pct[1]) : null;
  const rupees = [...t.matchAll(RUPEE)].map(m => ({ v: Number(m[1].replace(/,/g, '')), at: m.index }));
  const minM = t.match(/(?:min(?:imum)?\.?(?:\s*(?:txn|transaction|purchase|order|cart))?(?:\s*(?:value|amount))?(?:\s*of)?|(?:orders?|purchases?|transactions?|txns?)\s*(?:value\s*)?(?:of|above|over|worth)|above)\s*:?\s*(?:₹|rs\.?|inr)?\s?([\d,]+)/i);
  const minTxn = minM ? Number(minM[1].replace(/,/g, '')) : null;
  const upTo = t.match(/(?:up\s?to|upto|max(?:imum)?(?: discount| cashback)?(?: of)?)\s*(?:₹|rs\.?|inr)\s?([\d,]+)/i);
  let maxDiscount = upTo ? Number(upTo[1].replace(/,/g, '')) : null;

  let amount = null;
  const others = rupees.map(r => r.v).filter(v => v !== minTxn);
  if (percent === null) {
    amount = others[0] ?? null;
    if (maxDiscount && amount === maxDiscount) maxDiscount = null;  // "up to ₹1,500 off" is the flat amount
  } else if (!maxDiscount && others.length) maxDiscount = others[0];

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
    if (!o.amount && !o.percent && o.offerType !== 'no_cost_emi') continue;
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
