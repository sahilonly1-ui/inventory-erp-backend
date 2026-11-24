import { logger } from '../../config/logger';

/*
 * Finds a real specifications page for a product through ordinary web search (Bing,
 * then DuckDuckGo), so specs come from a page that can be checked — not from the AI's
 * memory. Only known spec sources and official brand sites are accepted, and the page
 * address or its result title must carry the product's model words.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36';

// Spec sources, best first. Brand sites are added per product.
const SOURCES = ['gadgets360.com', 'gsmarena.com', '91mobiles.com', 'smartprix.com', 'flipkart.com', 'amazon.in', 'croma.com', 'reliancedigital.in', 'digit.in', 'beebom.com'];

export interface WebHit { url: string; title: string; host: string; rank: number }

const decode = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

async function get(url: string): Promise<string> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    return r.ok ? await r.text() : '';
  } catch { return ''; } finally { clearTimeout(t); }
}

/** Bing wraps result links (bing.com/ck/a?…&u=a1<base64 of the address>). */
export function unwrapBing(href: string): string {
  const u = href.replace(/&amp;/g, '&');
  const enc = u.match(/[?&]u=a1([^&]+)/)?.[1];
  if (!/bing\.com\/ck\//.test(u) || !enc) return u;
  try { return Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return u; }
}
export function parseBing(html: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = unwrapBing(m[1]);
    if (/^https?:\/\//.test(url)) out.push({ url, title: decode(m[2]) });
  }
  return out;
}
export function parseDdg(html: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let u = m[1].replace(/&amp;/g, '&');
    const enc = u.match(/[?&]uddg=([^&]+)/)?.[1];
    if (enc) u = decodeURIComponent(enc);
    if (u.startsWith('//')) u = 'https:' + u;
    if (/^https?:\/\//.test(u)) out.push({ url: u, title: decode(m[2]) });
  }
  return out;
}

let pausedUntil = 0;
async function search(q: string): Promise<{ url: string; title: string }[]> {
  if (Date.now() < pausedUntil) return [];
  const ddg = parseDdg(await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`));
  if (ddg.length) return ddg;
  const bing = parseBing(await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-IN&cc=IN`));
  if (!bing.length) pausedUntil = Date.now() + 20 * 60_000;   // both refused: rest a while
  return bing;
}

const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);
const GENERIC = new Set(['5g', '4g', 'gb', 'tb', 'with', 'and', 'the', 'for', 'smartphone', 'mobile', 'phone', 'wireless', 'bluetooth', 'earbuds', 'earphone', 'earphones', 'tws', 'headset', 'headphone', 'headphones', 'speaker', 'portable', 'party', 'smartwatch', 'smart', 'watch', 'laptop', 'tv', 'inch', 'cm', 'black', 'blue', 'white', 'green', 'grey', 'gray', 'red', 'plastic', 'edition', 'new', 'cc', 'in']);

/**
 * Does a result belong to this product? The model numbers ("Q2s", "A3", "43", "110") must
 * all be there; SKU codes ("NP960QFG", "WF-LS900N", "SCMP130") may be missing; of the
 * other naming words most must be there.
 */
export function matchesProduct(title: string, brand: string, hit: { url: string; title: string }): boolean {
  // RAM / storage ("4/128GB", "256 GB"), sizes ("108 cm", "15.6") and bracketed extras are
  // often left out of page titles and addresses.
  const core = title.replace(/\([^)]*\)/g, ' ').replace(/\b([a-z]{1,4})-([a-z]*\d[a-z0-9]*)\b/gi, '$1$2').replace(/\b\d+\s*\/\s*\d+\s*(gb|tb)?\b/gi, ' ').replace(/\b\d+(\.\d+)?\s*(gb|tb|cm|inch|w|mah|mm)\b/gi, ' ').replace(/\b\d+\.\d+\b/g, ' ');
  const all = tokens(core).filter(t => !GENERIC.has(t) && t !== brand.toLowerCase());
  const sku = (t: string) => /[a-z]{2,}/.test(t) && /\d{3,}/.test(t) && t.length >= 6;
  const model = all.filter(t => /\d/.test(t) && !sku(t));
  const words = all.filter(t => !/\d/.test(t) && t.length > 1);
  if (!model.length && !words.length) return false;
  const hay = (tokens(hit.title).join(' ') + ' ' + tokens(decodeURIComponent(hit.url)).join(' ')).replace(/\s+/g, ' ');
  const list = hay.split(' ');
  const squashed = hay.replace(/\s+/g, '');
  const has = (w: string) => list.includes(w) || (w.length >= 3 && squashed.includes(w));
  if (!model.every(has)) return false;
  const found = words.filter(has).length;
  return words.length ? found / words.length >= 0.6 : model.length > 0;
}

/** Candidate spec pages for a product, best source first. */
export async function findSpecPages(title: string, brand: string, brandDomains: string[] = []): Promise<WebHit[]> {
  const allowed = [...brandDomains.map(d => d.replace(/^www\./, '')), ...SOURCES];
  const seen = new Set<string>();
  const hits: WebHit[] = [];
  for (const q of [`${title} specifications`, `${title} full specs price in India`]) {
    let results: { url: string; title: string }[] = [];
    try { results = await search(q); } catch { results = []; }
    for (const r of results) {
      const host = hostOf(r.url);
      const rank = allowed.findIndex(d => host === d || host.endsWith('.' + d));
      if (rank < 0 || seen.has(r.url)) continue;
      if (!matchesProduct(title, brand, r)) continue;
      seen.add(r.url);
      hits.push({ url: r.url, title: r.title, host, rank });
    }
    if (hits.length >= 3) break;
  }
  hits.sort((a, b) => a.rank - b.rank);
  if (!hits.length) logger.info({ title }, 'web search: no spec page found');
  return hits.slice(0, 4);
}
