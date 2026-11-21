// Which sites are compared, and how a URL is recognised as a real product page
// on each. A URL that fails these checks is never fetched — that is the first
// guard against showing the price of the wrong product.

export type StoreKey = 'amazon' | 'flipkart' | 'reliance' | 'croma' | 'official';

export interface StoreDef {
  key: StoreKey;
  label: string;
  domains: string[];
  // True when the page builds its price/offers with JavaScript, so a plain
  // HTTP fetch sees an empty shell and the scraper must render it.
  needsRender: boolean;
  isProductUrl: (u: URL) => boolean;
}

export const STORES: StoreDef[] = [
  {
    key: 'amazon', label: 'Amazon', domains: ['amazon.in'], needsRender: false,
    isProductUrl: u => /\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(u.pathname),
  },
  {
    key: 'flipkart', label: 'Flipkart', domains: ['flipkart.com'], needsRender: false,
    isProductUrl: u => /\/p\/itm[a-z0-9]+/i.test(u.pathname),
  },
  {
    key: 'reliance', label: 'Reliance Digital', domains: ['reliancedigital.in'], needsRender: true,
    isProductUrl: u => u.pathname.length > 10 && !/\/(search|collection|c|brand)\b/i.test(u.pathname),
  },
  {
    key: 'croma', label: 'Croma', domains: ['croma.com'], needsRender: true,
    isProductUrl: u => /\/p\/\d+/.test(u.pathname),
  },
  {
    key: 'official', label: 'Brand site', domains: [], needsRender: true,
    isProductUrl: u => u.pathname.length > 3,
  },
];

export const STORE_KEYS = STORES.map(s => s.key);
export const storeDef = (k: string) => STORES.find(s => s.key === k);

// Brand → official Indian store. Lower-case brand names as they appear in the
// Product Master. Unknown brands simply skip the "Brand site" column unless the
// admin pastes a URL for it.
export const BRAND_SITES: Record<string, string[]> = {
  jbl: ['in.jbl.com'],
  'harman kardon': ['in.harmankardon.com'],
  samsung: ['samsung.com'],
  apple: ['apple.com'],
  oneplus: ['oneplus.in'],
  xiaomi: ['mi.com'],
  mi: ['mi.com'],
  redmi: ['mi.com'],
  poco: ['mi.com'],
  sony: ['shopatsc.com', 'sony.co.in'],
  marshall: ['marshall.com'],
  bose: ['boseindia.com'],
  boat: ['boat-lifestyle.com'],
  noise: ['gonoise.com'],
  nothing: ['in.nothing.tech', 'nothing.tech'],
  cmf: ['in.nothing.tech', 'nothing.tech'],
  google: ['store.google.com'],
  motorola: ['motorola.in'],
  moto: ['motorola.in'],
  vivo: ['vivo.com'],
  oppo: ['oppo.com'],
  realme: ['realme.com'],
  iqoo: ['iqoo.com'],
  lenovo: ['lenovo.com'],
  hp: ['hp.com'],
  dell: ['dell.com'],
  asus: ['asus.com'],
  acer: ['acer.com'],
  lg: ['lg.com'],
  sennheiser: ['sennheiser.com'],
  'bang & olufsen': ['bang-olufsen.com'],
  honor: ['explorehonor.com'],
  tecno: ['tecno-mobile.in'],
  infinix: ['infinixmobiles.in', 'infinixmobility.com'],
  itel: ['itel-india.com'],
  hmd: ['hmd.com'],
  nokia: ['hmd.com'],
  'ai+': ['aiplusstore.com'],
  'ai plus': ['aiplusstore.com'],
  aiplus: ['aiplusstore.com'],
  portronics: ['portronics.com'],
  pebble: ['pebblecart.com'],
  gizmore: ['gizmore.in'],
  'fire boltt': ['fireboltt.com'],
  'fire-boltt': ['fireboltt.com'],
  fireboltt: ['fireboltt.com'],
  zebronics: ['zebronics.com'],
  carvaan: ['saregama.com'],
  saregama: ['saregama.com'],
  skullcandy: ['skullcandy.in'],
  fastrack: ['fastrack.in'],
  amazon: ['amazon.in'],
};

export function officialDomains(brand?: string | null): string[] {
  if (!brand) return [];
  return BRAND_SITES[brand.trim().toLowerCase()] ?? [];
}

const hostMatches = (host: string, domain: string) =>
  host === domain || host.endsWith('.' + domain);

/** Which store a URL belongs to, by its host (marketplaces only). */
export function storeOfUrl(raw: string): StoreKey | null {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return (STORES.find(s => s.domains.some(d => hostMatches(host, d)))?.key) ?? null;
  } catch { return null; }
}

// Share / short links the apps give out: they only redirect to the real page.
const SHORT_HOSTS = /(^|\.)(amzn\.in|amzn\.to|amzn\.eu|a\.co|dl\.flipkart\.com|fkrt\.it|fkrt\.cc|fkrt\.co|fkrt\.to|bit\.ly|tinyurl\.com|t\.co|rdl\.ink|croma\.page\.link)$/i;
export const isShortLink = (raw: string) => { try { return SHORT_HOSTS.test(new URL(raw.trim()).hostname); } catch { return false; } };

/** Follows a share / short link to the page it points at (redirect headers only). */
export async function resolveLink(raw: string): Promise<string> {
  let url = raw.trim();
  for (let hop = 0; hop < 8; hop++) {
    let next: string | null = null;
    try {
      const r = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36', accept: 'text/html' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) next = new URL(loc, url).toString();
      else if (r.ok && isShortLink(url)) {
        // Some short links answer with a page that redirects by script / meta tag.
        const html = (await r.text()).slice(0, 20000);
        const m = html.match(/(?:http-equiv=["']refresh["'][^>]*url=|window\.location(?:\.href)?\s*=\s*["'])([^"'>\s]+)/i)
          || html.match(/https:\/\/(?:www\.)?(?:amazon\.in|flipkart\.com)\/[^"'\s<>]+/i);
        if (m) next = new URL((m[1] ?? m[0]).replace(/&amp;/g, '&'), url).toString();
      }
    } catch { /* keep what we have */ }
    if (!next || next === url) break;
    url = next;
    if (!isShortLink(url)) {
      // Real store page reached (Amazon may redirect /d/... once more to /dp/...).
      if (/amazon\.in\/(dp|gp\/product)\//i.test(url) || /flipkart\.com\/.+\/p\/itm/i.test(url) || !storeOfUrl(url)) break;
    }
  }
  return url;
}

/**
 * A URL the admin gave by hand: the host must be the store's, nothing more —
 * the admin knows which page they mean. Canonicalised when the format is known.
 */
export function normaliseAdminUrl(store: StoreKey, raw: string, brand?: string | null): string | null {
  const strict = normaliseStoreUrl(store, raw, brand);
  if (strict) return strict;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const def = storeDef(store);
  if (!def) return null;
  if (store === 'official') {
    if (STORES.some(s => s.domains.some(d => hostMatches(host, d)))) return null;
  } else if (!def.domains.some(d => hostMatches(host, d))) return null;
  if (u.pathname.length <= 1) return null;          // a home page is not a product
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref|srsltid|_refId|_appId|tag|linkCode|smid|psc)/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** Validates a URL for a store and returns its canonical form, or null. */
export function normaliseStoreUrl(store: StoreKey, raw: string, brand?: string | null): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const def = storeDef(store);
  if (!def) return null;
  const domains = store === 'official' ? officialDomains(brand) : def.domains;
  // A pasted official URL for a brand we have no domain for is accepted as long
  // as it isn't one of the marketplaces.
  if (store === 'official' && !domains.length) {
    if (STORES.some(s => s.domains.some(d => hostMatches(host, d)))) return null;
  } else if (!domains.some(d => hostMatches(host, d))) return null;
  if (!def.isProductUrl(u)) return null;

  if (store === 'amazon') {
    const asin = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
    return asin ? `https://www.amazon.in/dp/${asin.toUpperCase()}` : null;
  }
  if (store === 'flipkart') {
    const pid = u.searchParams.get('pid');
    return `https://www.flipkart.com${u.pathname}${pid ? `?pid=${pid}` : ''}`;
  }
  u.hash = '';
  // Tracking params change between searches; the page is the same.
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref|srsltid)/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** Identity used to check that a URL the AI picked really came from search. */
export function urlIdentity(store: StoreKey, url: string): string {
  try {
    const u = new URL(url);
    if (store === 'amazon') return (u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] ?? url).toUpperCase();
    if (store === 'flipkart') return u.pathname.match(/\/p\/(itm[a-z0-9]+)/i)?.[1]?.toLowerCase() ?? url;
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch { return url; }
}

/** Where the browser agent starts when no product page is known yet. */
export function searchUrl(store: StoreKey, query: string, brand?: string | null): string | null {
  const q = encodeURIComponent(query.trim());
  switch (store) {
    case 'amazon': return `https://www.amazon.in/s?k=${q}`;
    case 'flipkart': return `https://www.flipkart.com/search?q=${q}`;
    case 'reliance': return `https://www.reliancedigital.in/products?q=${q}`;
    case 'croma': return `https://www.croma.com/searchB?q=${q}`;
    case 'official': {
      const d = officialDomains(brand)[0];
      return d ? `https://www.google.com/search?q=${encodeURIComponent(`site:${d} ${query}`)}` : null;
    }
  }
}
