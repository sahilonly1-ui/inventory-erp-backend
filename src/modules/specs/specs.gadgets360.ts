import { logger } from '../../config/logger';

/*
 * Gadgets 360 (NDTV) reader — free, no AI, and it answers servers (GSMArena,
 * 91mobiles, Smartprix block them). Covers phones, tablets, smartwatches and
 * more. Search → best matching "…-price-in-india-<id>" page → spec rows →
 * the sheet's columns.
 */

const BASE = 'https://www.gadgets360.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

let last = 0;
async function get(url: string): Promise<string> {
  const wait = last + 1500 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) throw new Error(`Gadgets 360 returned ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const decode = (s: string) => s
  .replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&times;/g, 'x').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();

// Brand / series words that one side often has and the other doesn't.
const FILLER = new Set(['galaxy', 'moto', 'motorola', 'xiaomi', 'mi', 'samsung', 'apple', 'oneplus', 'vivo', 'oppo', 'realme', 'poco', 'iqoo', 'nothing', 'smartphone', 'mobile', 'phone']);
const NET = new Set(['5g', '4g', 'lte']);
const tokens = (s: string) => s.toLowerCase()
  .replace(/([a-z]*\d+)[\s_-]+([a-z])\b/g, '$1$2')          // "c25_y" / "c21 -y" → "c25y" / "c21y"
  .replace(/[^a-z0-9+]+/g, ' ').trim().split(' ').filter(w => w && !FILLER.has(w));

export function cleanSearchName(title: string): string {
  return title
    .replace(/\b\d+\s*\/\s*\d+\s*(gb|tb)\b/gi, ' ').replace(/\b\d+\s*(gb|tb)\b/gi, ' ')
    .replace(/\b[A-Z0-9]{5,}\/[A-Z]\b/g, ' ').replace(/\s+/g, ' ').trim();
}

type Hit = { url: string; name: string };
export function parseSearch(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of html.matchAll(/href="((?:https?:\/\/www\.gadgets360\.com)?\/([a-z0-9-]+)-price-in-india-(\d+))(?:#[^"]*)?"/gi)) {
    const url = m[1].startsWith('http') ? m[1] : BASE + m[1];
    if (!hits.some(h => h.url === url)) hits.push({ url, name: m[2].replace(/-/g, ' ') });
  }
  return hits;
}

function score(ours: string, theirs: string): number {
  const A = tokens(ours), B = tokens(theirs);
  const a = A.filter(w => !NET.has(w)), b = B.filter(w => !NET.has(w));
  if (!a.length || !b.length) return 0;
  const as = new Set(a), bs = new Set(b);
  const hit = a.filter(w => bs.has(w)).length;
  const extra = b.filter(w => !as.has(w)).length;               // "pro", "plus", "max" we don't have
  const numsA = a.filter(w => /\d/.test(w)), numsB = b.filter(w => /\d/.test(w));
  const numsOk = numsA.every(n => bs.has(n)) && numsB.every(n => as.has(n)) ? 1 : 0;
  // 5G/4G only nudges the choice (sites often leave it out of the name).
  const netA = A.find(w => NET.has(w)), netB = B.find(w => NET.has(w));
  const net = netA && netB ? (netA === netB ? 0.15 : -0.3) : 0;
  return hit / a.length + numsOk - extra * 0.5 + net + (!netA && !netB ? 0.05 : 0);
}

export async function findProduct(title: string, brand: string): Promise<string | null> {
  const name = cleanSearchName(title);
  const noBrand = name.replace(new RegExp(`^${brand}\\s+`, 'i'), '').trim();
  const tries = [name, noBrand, `${brand} ${noBrand}`];
  let best: { url: string; s: number; name: string } | null = null;
  for (const q of [...new Set(tries.filter(Boolean))]) {
    const html = await get(`${BASE}/search?searchtext=${encodeURIComponent(q)}`);
    for (const h of parseSearch(html)) {
      const s = score(name, h.name);
      if (!best || s > best.s) best = { url: h.url, s, name: h.name };
    }
    if (best && best.s >= 1.8) break;
  }
  if (best && best.s >= 1.6) return best.url;
  logger.info({ title, best: best?.name, score: best?.s?.toFixed(2) }, 'Gadgets 360: no confident match');
  return null;
}

/** Every label → value pair on the page (tables, definition lists, two-span rows). */
export function parseRows(html: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const put = (k: string, v: string) => {
    const key = decode(k).replace(/:$/, '').toLowerCase();
    const val = decode(v);
    if (key && val && key.length < 60 && val.length < 300 && !rows[key]) rows[key] = val;
  };
  for (const m of html.matchAll(/<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) put(m[1], m[2]);
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) put(m[1], m[2]);
  for (const m of html.matchAll(/<li[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/gi)) put(m[1], m[2]);
  for (const m of html.matchAll(/<div[^>]*class="[^"]*(?:_lbl|label|title)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*(?:_val|value|desc)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) put(m[1], m[2]);
  return rows;
}

let loggedLabels = false;

/** Map Gadgets 360 rows to our columns. Works for any template: unknown fields stay empty. */
export function toColumns(rows: Record<string, string>, title: string, keys: string[]): Record<string, string> {
  if (!loggedLabels) { loggedLabels = true; logger.info({ labels: Object.keys(rows).slice(0, 80) }, 'Gadgets360 labels'); }
  const find = (...res: RegExp[]) => {
    for (const re of res) for (const [k, v] of Object.entries(rows)) if (re.test(k)) return v;
    return '';
  };
  const yes = (v: string) => /^yes\b/i.test(v);
  const out: Record<string, string> = {};

  // Processor
  const make = find(/^processor make$/, /^chipset$/, /^soc$/);
  const proc = find(/^processor$/, /^processor name$/, /^cpu$/);
  const procTxt = [make, proc && !make.toLowerCase().includes(proc.toLowerCase()) ? proc : ''].filter(Boolean).join(' — ');
  if (procTxt) out.processor = procTxt;

  // RAM & storage — our variant comes from the product name.
  const v = title.match(/\b(\d+)\s*\/\s*(\d+)\s*(GB|TB)\b/i);
  const ram = find(/^ram$/), rom = find(/^internal storage$/, /^storage$/, /^inbuilt storage$/);
  if (v) out.ramStorage = `${v[1]}GB RAM, ${v[2]}${v[3].toUpperCase()} storage`;
  else if (ram || rom) out.ramStorage = [ram && `${ram} RAM`, rom && `${rom} storage`].filter(Boolean).join(', ');

  // Display
  const size = find(/^screen size/, /^display size/, /^dial size/);
  const res = find(/^resolution$/, /^screen resolution/, /^display resolution/);
  const type = find(/^display type$/, /^screen type$/, /^display$/, /^panel type/);
  const hz = find(/^refresh rate/);
  const disp = [size && `${size.replace(/\s*inch(es)?/i, '')}"`, type, hz && (/hz/i.test(hz) ? hz : `${hz}Hz`), res].filter(Boolean).join(', ');
  if (disp) out.display = disp;

  // Camera
  const rear = find(/^rear camera$/, /^primary camera$/, /^main camera$/);
  const front = find(/^front camera$/, /^selfie camera$/, /^secondary camera$/);
  const mp = (s: string) => (s.match(/\d+(?:\.\d+)?(?=\s*-?\s*(?:megapixel|mp))/gi) ?? []).map(x => `${x}MP`).join(' + ');
  if (rear || front) out.camera = [rear && `${mp(rear) || rear} rear`, front && `${mp(front) || front} front`].filter(Boolean).join(', ');

  // Battery & charging
  const mah = find(/^battery capacity/, /^battery$/);
  const charge = find(/^fast charging$/, /^wired charging/, /^charging speed/, /^charging$/);
  const bat = [mah && (/(mah|hours|days)/i.test(mah) ? mah : `${mah} mAh`), charge && !/^(yes|no)$/i.test(charge) ? `${charge} charging` : charge && yes(charge) ? 'fast charging' : '']
    .filter(Boolean).join(', ');
  if (bat) out.battery = bat;

  // OS & updates
  const os = find(/^operating system$/, /^os$/);
  const skin = find(/^skin$/, /^ui$/);
  const upd = find(/os updates|software updates|update/);
  const osTxt = [os, skin && !os.toLowerCase().includes(skin.toLowerCase()) ? skin : '', upd && `${upd} updates`].filter(Boolean).join(', ');
  if (osTxt) out.os = osTxt;

  // Network & connectivity
  const fiveG = yes(find(/^5g$/)), fourG = yes(find(/^4g/, /^4g\/ lte$/));
  const sims = find(/^number of sims$/, /^sim type$/);
  const wifi = find(/^wi-?fi standards/, /^wi-?fi$/);
  const btv = find(/^bluetooth version/, /^bluetooth$/);
  const nfc = yes(find(/^nfc$/));
  const net = [fiveG ? '5G' : fourG ? '4G' : '', /2/.test(sims) ? 'Dual SIM' : '', wifi && !/^(yes|no)$/i.test(wifi) ? `Wi-Fi ${wifi}` : yes(wifi) ? 'Wi-Fi' : '',
               btv && !/^no$/i.test(btv) ? `BT ${btv.replace(/^yes,?\s*/i, '') || ''}`.trim() : '', nfc ? 'NFC' : ''].filter(Boolean).join(', ');
  if (net) { out.network = net; out.connectivity = net; }

  // Expandable storage
  const exp = find(/^expandable storage$/);
  if (exp) {
    if (/^no/i.test(exp)) out.expandable = 'No';
    else {
      const upto = find(/expandable storage up to/);
      const kind = find(/expandable storage type/);
      out.expandable = ['Yes', kind, upto && `up to ${upto.replace(/\s*gb$/i, '')}GB`].filter(Boolean).join(', ');
    }
  }

  // Wearables / audio / others (used when the category's template has these keys)
  const water = find(/water resistan/, /^ip rating/, /dust and water/);
  if (water) out.water = water;
  const compat = find(/compatible os/, /^compatibility/);
  if (compat) out.compatibility = compat;
  const health = [find(/heart rate/) && 'Heart rate', find(/spo2|blood oxygen/) && 'SpO2', find(/sleep/) && 'Sleep', find(/step/) && 'Steps'].filter(Boolean).join(', ');
  if (health) out.health = health;
  const calling = find(/calling/);
  if (calling && keys.includes('connectivity')) out.connectivity = [yes(calling) ? 'Bluetooth calling' : '', out.connectivity].filter(Boolean).join(', ');
  const anc = find(/noise cancell?ation/, /^anc$/);
  if (anc) out.anc = anc;
  const driver = find(/driver/);
  if (driver) out.driver = driver;

  const picked: Record<string, string> = {};
  for (const k of keys) if (out[k]) picked[k] = out[k];
  return picked;
}

export async function readProduct(url: string, title: string, keys: string[]) {
  const html = await get(url);
  const rows = parseRows(html);
  return { specs: toColumns(rows, title, keys), rowCount: Object.keys(rows).length, text: decode(html).slice(0, 60_000) };
}
