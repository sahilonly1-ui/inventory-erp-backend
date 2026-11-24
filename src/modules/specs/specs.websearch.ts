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

export function parseBing(html: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) out.push({ url: m[1].replace(/&amp;/g, '&'), title: decode(m[2]) });
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
  const bing = parseBing(await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-IN&cc=IN`));
  if (bing.length) return bing;
  const ddg = parseDdg(await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`));
  if (!ddg.length) pausedUntil = Date.now() + 20 * 60_000;   // both refused: rest a while
  return ddg;
}

const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);
const GENERIC = new Set(['5g', '4g', 'gb', 'with', 'and', 'the', 'smartphone', 'mobile', 'phone', 'wireless', 'bluetooth', 'earbuds', 'speaker', 'smartwatch', 'watch', 'headphones', 'black', 'blue', 'white', 'green']);

/** Does a result belong to this product? Every model word (digits included) must be there. */
export function matchesProduct(title: string, brand: string, hit: { url: string; title: string }): boolean {
  // RAM / storage ("4/128GB", "256 GB") is often left out of page titles and addresses.
  const core = title.replace(/\b\d+\s*\/\s*\d+\s*(gb|tb)?\b/gi, ' ').replace(/\b\d+\s*(gb|tb)\b/gi, ' ');
  const want = tokens(core).filter(t => !GENERIC.has(t) && t !== brand.toLowerCase() && !/^\d+gb$/.test(t) && !/^\d+\/\d+$/.test(t));
  if (!want.length) return false;
  const hay = (tokens(hit.title).join(' ') + ' ' + tokens(decodeURIComponent(hit.url)).join(' ')).replace(/\s+/g, ' ');
  const squashed = hay.replace(/\s+/g, '');
  return want.every(w => hay.split(' ').includes(w) || (w.length >= 3 && squashed.includes(w)));
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
