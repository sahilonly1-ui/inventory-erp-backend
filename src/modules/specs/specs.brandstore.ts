import { logger } from '../../config/logger';

/*
 * Official brand stores. Most Indian accessory brands sell on Shopify, which
 * exposes product search and product data as JSON that servers may read.
 * We find the product on the brand's own store and hand its official page text
 * to the AI to fill the sheet's columns.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Brand (lower-case, as written in Product Master) → official store domains to try.
const STORES: Record<string, string[]> = {
  'boat': ['www.boat-lifestyle.com'],
  'noise': ['www.gonoise.com'],
  'fire boltt': ['www.fireboltt.com'], 'fire-boltt': ['www.fireboltt.com'], 'fireboltt': ['www.fireboltt.com'],
  'boult': ['www.boultaudio.com'], 'boult audio': ['www.boultaudio.com'],
  'portronics': ['www.portronics.com'],
  'ambrane': ['ambraneindia.com'],
  'mivi': ['www.mivi.in'],
  'ptron': ['www.ptron.in'],
  'truke': ['truke.in'],
  'urbn': ['urbn.in'],
  'stuffcool': ['stuffcool.in'],
  'gizmore': ['gizmore.in', 'www.gizmore.in'],
  'maxima': ['maximawatches.com', 'www.maximawatches.com'],
  'fastrack': ['www.fastrack.in'],
  'crossbeats': ['crossbeats.in', 'www.crossbeats.in'],
  'zebronics': ['zebronics.com'],
  'erd': ['erdtech.in', 'www.erdtech.in'],
  'forbes': ['www.forbesgadgets.in'],
  'infinity': ['www.infinitylifestyle.in'],
  'marshall': ['www.marshall.com'],
  'jbl': ['in.jbl.com'],
  'nothing': ['in.nothing.tech'],
  'cmf': ['in.nothing.tech'],
};

async function getJson(url: string): Promise<any | null> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

const strip = (h: string) => String(h ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim().split(' ').filter(w => w.length > 0);

// Descriptive words stores and our names use differently; they don't identify the model.
const GENERIC = new Set(('portable wireless bluetooth speaker speakers party earbuds earphone earphones headphone headphones ' +
  'neckband tws true with mic rgb smart watch smartwatch power bank charger adapter cable fast charging the and for ' +
  'black white blue green grey gray silver gold red pink purple orange yellow beige navy teal type usb c led new edition ' +
  'over ear in ear on ear noise cancelling anc enc stereo sound bass hd dual pro').split(' '));
/** Model-identifying words: name + short model numbers; drops wattage, capacities and long part codes. */
function core(s: string, brand: string): string[] {
  const b = brand.toLowerCase();
  const w = words(s).filter(x => x !== b && !GENERIC.has(x) && !/^\d+(w|mah|hrs?|h|mm|m|ft|cm)$/.test(x) && !/^\d{4,}$/.test(x));
  // "POR 1976"-style part codes: drop the short brand prefix that goes with them.
  return w.filter((x, i) => !(/^[a-z]{2,4}$/.test(x) && /^\d{4,}$/.test(words(s)[words(s).indexOf(x) + 1] ?? '')));
}

function score(ours: string, theirs: string, brand: string): number {
  const a = core(ours, brand), t = new Set(words(theirs));
  if (!a.length) return 0;
  const hit = a.filter(w => t.has(w)).length;
  const nums = a.filter(w => /\d/.test(w));
  const numsOk = nums.every(n => t.has(n)) ? 0.5 : -0.5;
  return hit / a.length + numsOk;
}

/** Official product page text for this model, or null. */
export async function findOnBrandStore(brand: string, title: string): Promise<{ url: string; text: string } | null> {
  const domains = STORES[brand.trim().toLowerCase()];
  if (!domains) return null;
  // Search with the model name, without colour and brand words.
  const full = title.replace(new RegExp(`^${brand}\\s+`, 'i'), '').replace(/\s+/g, ' ').trim();
  const q = core(full, brand).join(' ') || full;          // search with the model words only: "Radiant 2"
  const queries = [...new Set([q, full])];
  for (const d of domains) {
    let products: any[] = [];
    for (const qq of queries) {
      const res = await getJson(`https://${d}/search/suggest.json?q=${encodeURIComponent(qq)}&resources[type]=product&resources[limit]=8`);
      products = res?.resources?.results?.products ?? [];
      if (products.length) break;
    }
    if (!products.length) continue;
    let best: any = null, bestS = -9;
    for (const p of products) {
      const s = score(full, `${p.title} ${(p.handle ?? '').replace(/-/g, ' ')}`, brand);
      if (s > bestS) { best = p; bestS = s; }
    }
    if (!best || bestS < 1.25) { logger.info({ brand, q, best: best?.title, score: bestS.toFixed(2) }, 'brand store: no confident match'); continue; }
    const handle = best.handle || String(best.url || '').split('/products/')[1]?.split('?')[0];
    if (!handle) continue;
    const prod = await getJson(`https://${d}/products/${handle}.js`);
    const url = `https://${d}/products/${handle}`;
    const text = [best.title, strip(prod?.description ?? best.body ?? ''), (prod?.tags ?? []).join(', '),
      (prod?.options ?? []).map((o: any) => `${o.name}: ${(o.values ?? []).join(', ')}`).join('\n')].filter(Boolean).join('\n');
    if (text.length > 200) return { url, text: text.slice(0, 40_000) };
  }
  return null;
}
