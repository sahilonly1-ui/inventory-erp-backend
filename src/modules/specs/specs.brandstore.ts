import { logger } from '../../config/logger';

/*
 * Official brand stores. Most Indian accessory brands sell on Shopify, which
 * exposes product search and product data as JSON that servers may read.
 * We find the product on the brand's own store and hand its official page text
 * to the AI to fill the sheet's columns.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Brand (lower-case, as written in Product Master) → official store domains to try.
// Checked from the server: these official Shopify stores answer product search as JSON.
// (JBL, Fastrack, Maxima, Mivi, Nothing, Saregama, Truke block or don't expose it.)
const STORES: Record<string, string[]> = {
  'boat': ['www.boat-lifestyle.com'],
  'noise': ['www.gonoise.com'],
  'fire boltt': ['www.fireboltt.com'], 'fire-boltt': ['www.fireboltt.com'], 'fireboltt': ['www.fireboltt.com'],
  'boult': ['www.boultaudio.com'], 'boult audio': ['www.boultaudio.com'],
  'portronics': ['www.portronics.com'],
  'ambrane': ['ambraneindia.com'],
  'ptron': ['www.ptron.in'],
  'gizmore': ['gizmore.in'],
  'crossbeats': ['www.crossbeats.in'],
  'zebronics': ['zebronics.com'], 'zeb': ['zebronics.com'],
  'toreto': ['www.toreto.in'],
};

export const storeBrands = () => Object.keys(STORES);

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
  const tw = words(theirs);
  const t = new Set(tw);
  // Joined / split spellings: "Sound Drum" ↔ "SoundDrum", "Stone Arc" ↔ "StoneArc".
  for (let i = 0; i < tw.length - 1; i++) t.add(tw[i] + tw[i + 1]);
  let a = core(ours, brand);
  const merged: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (i < a.length - 1 && !t.has(a[i]) && t.has(a[i] + a[i + 1])) { merged.push(a[i] + a[i + 1]); i++; }
    else merged.push(a[i]);
  }
  a = merged;
  if (!a.length) return 0;
  const hit = a.filter(w => t.has(w)).length;
  const nums = a.filter(w => /\d/.test(w));
  const numsOk = nums.every(n => t.has(n)) ? 0.5 : -0.5;
  return hit / a.length + numsOk;
}

// ── Reading specs off the official page without AI ────────────────────────
const decode = (h: string) => strip(h).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

/** Label → value pairs from spec tables, definition lists, two-cell rows and "Label: value" lines. */
export function specPairs(html: string, plainText: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const put = (k: string, v: string) => {
    const key = decode(k).replace(/[:\-–]+$/, '').trim().toLowerCase();
    const val = decode(v).replace(/^[:\-–]\s*/, '').trim();
    if (key && val && key.length <= 40 && val.length <= 200 && !/^(sku|price|mrp|qty|quantity|reviews?)$/.test(key) && !rows[key]) rows[key] = val;
  };
  for (const m of html.matchAll(/<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) put(m[1], m[2]);
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) put(m[1], m[2]);
  for (const m of html.matchAll(/<li[^>]*>\s*<(?:strong|b|span)[^>]*>([^<]{2,40})<\/(?:strong|b|span)>\s*:?\s*([\s\S]*?)<\/li>/gi)) put(m[1], m[2]);
  for (const line of plainText.split(/\n|•|\|/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ./&()-]{1,38}?)\s*[:–-]\s+(.{2,160})$/);
    if (m) put(m[1], m[2]);
  }
  return rows;
}

// Column key → labels that carry it on brand pages (first match wins; several may be joined).
const FIELD_LABELS: Record<string, RegExp[]> = {
  driver:        [/driver/, /speaker size/],
  anc:           [/\banc\b|noise cancel|\benc\b|noise reduction/],
  battery:       [/playback|play ?time|battery life|music time|talk time/, /battery capacity|battery$/, /charging time|full charge/, /fast charg|asap charge|quick charge/],
  connectivity:  [/bluetooth( version)?$|bt version/, /connectivity|wireless range|range/, /codec/],
  water:         [/ip ?x?\d|ip rating|water|sweat|splash/],
  features:      [/latency|game mode|beast mode/, /voice assistant|calling|mic/, /app support|eq|equali/],
  output:        [/output power|sound output|power output|\brms\b|^output$|wattage/],
  capacity:      [/capacity|mah/],
  ports:         [/ports?$|input|output port|usb/],
  protocol:      [/\bpd\b|qc|quick charge|protocol|fast charging standard|power delivery/],
  weight:        [/weight/, /dimension|size/],
  compatibility: [/compatib/],
  cable:         [/cable included|in the box/],
  type:          [/connector|cable type|interface/],
  length:        [/length/],
  power:         [/current|max power|power rating|data transfer|data speed/],
  build:         [/material|build|braid/],
  display:       [/display|screen size|screen/, /resolution/, /brightness|nits/],
  health:        [/health|heart|spo2|sleep|sensor|fitness/],
  inBox:         [/in the box|box content|package content/],
};

export function pairsToColumns(rows: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(rows);
  // Say what a bare value means: "v5.3" → "Bluetooth v5.3", "1.5 Hours" → "1.5 Hours charge time".
  const label = (k: string, lbl: string, v: string) => {
    if (k === 'battery' && /playback|play ?time|battery life|music time/.test(lbl) && !/playback/i.test(v)) return `${v} playback`;
    if (k === 'battery' && /charging time|full charge/.test(lbl) && !/charg/i.test(v)) return `${v} full charge`;
    if (k === 'battery' && /talk time/.test(lbl) && !/talk/i.test(v)) return `${v} talk time`;
    if (k === 'connectivity' && /bluetooth|bt version/.test(lbl) && !/bluetooth|\bbt\b/i.test(v)) return `Bluetooth ${v}`;
    if (k === 'connectivity' && /range/.test(lbl) && !/range/i.test(v)) return `${v} range`;
    return v;
  };
  for (const k of keys) {
    const res = FIELD_LABELS[k];
    if (!res) continue;
    const parts: string[] = [];
    for (const re of res) {
      const hit = entries.find(([lbl]) => re.test(lbl));
      if (hit) { const v = label(k, hit[0], hit[1]); if (!parts.includes(v)) parts.push(v); }
      if (parts.length >= 3) break;
    }
    // ANC is often written in the value of a differently named row ("ENx Technology: …noise cancellation").
    if (!parts.length && k === 'anc') {
      const hit = entries.find(([, v]) => /noise cancel|\banc\b|\benc\b/i.test(v));
      if (hit) parts.push(hit[1]);
    }
    if (parts.length) out[k] = parts.join(', ').slice(0, 220);
  }
  return out;
}

/** Official product page text for this model, or null. */
export async function findOnBrandStore(brand: string, title: string): Promise<{ url: string; text: string; html: string } | null> {
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
    let pageHtml = '';
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) pageHtml = (await r.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    } catch { /* description alone */ }
    const descHtml = String(prod?.description ?? best.body ?? '');
    const text = [best.title, strip(descHtml), (prod?.tags ?? []).join(', '),
      (prod?.options ?? []).map((o: any) => `${o.name}: ${(o.values ?? []).join(', ')}`).join('\n')].filter(Boolean).join('\n');
    const html = `${descHtml}\n${pageHtml}`;
    if (text.length > 200 || pageHtml.length > 2000) return { url, text: `${text}\n${strip(pageHtml).slice(0, 25_000)}`.slice(0, 40_000), html };
  }
  return null;
}
