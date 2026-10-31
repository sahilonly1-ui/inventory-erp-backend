/*
 * GSMArena reader for Smartphones and Tablets (free, no AI).
 *
 * 1. Search GSMArena for the model (RAM/storage and colour removed).
 * 2. Pick the result whose name best matches ours.
 * 3. Read the spec table and turn it into the sheet's columns.
 *
 * GSMArena throttles bursts, so calls are spaced out (one at a time, a few
 * seconds apart) and a block is reported as a temporary error that is retried later.
 */

const BASE = 'https://www.gsmarena.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

let last = 0;
async function politeGet(url: string): Promise<string> {
  const wait = last + 3500 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow' });
  if (r.status === 429 || r.status === 403) throw new Error('GSMArena is limiting requests right now — will try again later.');
  if (!r.ok) throw new Error(`GSMArena returned ${r.status}`);
  return r.text();
}

const decode = (s: string) => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim();

const norm = (s: string) => s.toLowerCase().replace(/\bgalaxy\b|\bmotorola\b/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();

/** Words we search with: model name without brand-noise, RAM/storage, model codes. */
export function searchName(title: string): string {
  return title
    .replace(/\b\d+\s*\/\s*\d+\s*(gb|tb)\b/gi, ' ')
    .replace(/\b\d+\s*(gb|tb)\b/gi, ' ')
    .replace(/\b[A-Z0-9]{5,}\/[A-Z]\b/g, ' ')       // Apple part numbers like MQD83HN/A
    .replace(/\s+/g, ' ').trim();
}

type Hit = { href: string; name: string };
export function parseResults(html: string): Hit[] {
  const box = html.match(/<div class="makers">([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const hits: Hit[] = [];
  const re = /<a href="([^"]+\.php)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(box))) hits.push({ href: m[1], name: decode(m[2]).replace(/\n/g, ' ').replace(/\s+/g, ' ') });
  return hits;
}

function score(ours: string, theirs: string): number {
  const a = norm(ours).split(' ').filter(Boolean);
  const b = norm(theirs).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const bs = new Set(b), as = new Set(a);
  const hit = a.filter(w => bs.has(w)).length;
  const extra = b.filter(w => !as.has(w)).length;      // "Pro", "Plus", "Max" we don't have
  const numsA = a.filter(w => /\d/.test(w)), numsB = b.filter(w => /\d/.test(w));
  const numsOk = numsA.every(n => bs.has(n)) && numsB.every(n => as.has(n)) ? 1 : 0;
  return hit / a.length + numsOk - extra * 0.35;
}

export async function findPhonePage(title: string, brand: string): Promise<string | null> {
  const q = searchName(title);
  const tries = [q, q.replace(new RegExp(`^${brand}\\s+`, 'i'), ''), `${brand} ${q.replace(new RegExp(`^${brand}\\s+`, 'i'), '')}`];
  let best: { href: string; s: number } | null = null;
  for (const t of [...new Set(tries.map(x => x.trim()).filter(Boolean))]) {
    const html = await politeGet(`${BASE}results.php3?sQuickSearch=yes&sName=${encodeURIComponent(t)}`);
    for (const h of parseResults(html)) {
      const s = score(q, h.name);
      if (!best || s > best.s) best = { href: h.href, s };
    }
    if (best && best.s >= 1.8) break;
  }
  return best && best.s >= 1.5 ? BASE + best.href : null;
}

/** section → title → value, e.g. spec["Platform"]["Chipset"]. Also keyed by data-spec. */
export function parseSpecPage(html: string): { bySpec: Record<string, string>; byTitle: Record<string, string>; name: string } {
  const bySpec: Record<string, string> = {}, byTitle: Record<string, string> = {};
  const name = decode(html.match(/<h1[^>]*class="specs-phone-name-title"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  let section = '';
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const th = row.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    if (th) section = decode(th[1]);
    const ttl = decode(row.match(/<td class="ttl"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '');
    const nfoM = row.match(/<td class="nfo"([^>]*)>([\s\S]*?)<\/td>/i);
    if (!nfoM) continue;
    const val = decode(nfoM[2]);
    const ds = (nfoM[1].match(/data-spec="([^"]+)"/) ?? nfoM[2].match(/data-spec="([^"]+)"/))?.[1];
    if (ds && !bySpec[ds]) bySpec[ds] = val;
    const k = `${section}|${ttl || '_'}`;
    byTitle[k] = byTitle[k] ? `${byTitle[k]}\n${val}` : val;
  }
  return { bySpec, byTitle, name };
}

const firstLine = (s?: string) => (s ?? '').split('\n')[0].trim();
const mps = (s?: string) => [...(s ?? '').matchAll(/(\d+(?:\.\d+)?)\s*MP/gi)].map(m => `${m[1]}MP`);

/** Turn GSMArena's table into the sheet columns. `title` supplies our RAM/storage variant. */
export function toSheet(p: ReturnType<typeof parseSpecPage>, title: string): Record<string, string> {
  const S = p.bySpec, T = p.byTitle;
  const get = (sec: string, ttl: string) => T[`${sec}|${ttl}`] ?? '';
  const out: Record<string, string> = {};

  const chip = S.chipset || get('Platform', 'Chipset');
  if (chip) out.processor = chip.replace(/\s+/g, ' ');

  const v = title.match(/\b(\d+)\s*\/\s*(\d+)\s*(GB|TB)\b/i);
  const st = title.match(/\b(\d+)\s*(GB|TB)\b/i);
  const memType = (get('Memory', '_') || '').match(/UFS\s*[\d.]+|eMMC\s*[\d.]+/i)?.[0];
  if (v) out.ramStorage = `${v[1]}GB RAM, ${v[2]}${v[3].toUpperCase()} storage${memType ? ` (${memType})` : ''}`;
  else if (st) out.ramStorage = `${st[1]}${st[2].toUpperCase()} storage${memType ? ` (${memType})` : ''}`;
  else if (S.internalmemory) out.ramStorage = S.internalmemory.split(',').slice(0, 3).join(',').trim();

  const size = firstLine(S.displaysize).match(/[\d.]+\s*inches/i)?.[0]?.replace(/\s*inches/i, '"');
  const type = (S.displaytype || '').split(',').filter(x => !/nits|HBM|peak|typ/i.test(x)).slice(0, 3).join(',').trim();
  const res = firstLine(S.displayresolution).match(/\d+\s*x\s*\d+/)?.[0]?.replace(/\s/g, '');
  if (size || type) out.display = [[size, type].filter(Boolean).join(' '), res].filter(Boolean).join(', ');

  const rear = mps(S.cam1modules || get('Main Camera', 'Single') || get('Main Camera', 'Dual') || get('Main Camera', 'Triple') || get('Main Camera', 'Quad'));
  const front = mps(S.cam2modules || get('Selfie camera', 'Single') || get('Selfie camera', 'Dual'));
  if (rear.length || front.length) out.camera = [rear.length && `${rear.join(' + ')} rear`, front.length && `${front.join(' + ')} front`].filter(Boolean).join(', ');

  const mah = (S.batdescription1 || get('Battery', 'Type')).match(/\d{3,5}\s*mAh/i)?.[0]?.replace(/\s/g, ' ');
  const watt = (get('Battery', 'Charging') || '').match(/(\d+(?:\.\d+)?)\s*W\s*wired/i)?.[1]
            ?? (get('Battery', 'Charging') || '').match(/(\d+(?:\.\d+)?)\s*W/i)?.[1];
  if (mah || watt) out.battery = [mah, watt && `${watt}W charging`].filter(Boolean).join(', ');

  if (S.os || get('Platform', 'OS')) out.os = (S.os || get('Platform', 'OS')).replace(/\s+/g, ' ');

  const tech = (S.nettech || get('Network', 'Technology')).split('/').map(x => x.trim());
  const gen = tech.includes('5G') ? '5G' : tech.includes('LTE') ? '4G LTE' : tech.pop() || '';
  const wifi = (S.wlan || get('Comms', 'WLAN')).match(/Wi-?Fi\s*802\.11\s*([a-z/]+)/i)?.[1] ?? '';
  const wifiGen = /be/.test(wifi) ? 'Wi-Fi 7' : /ax/.test(wifi) ? 'Wi-Fi 6' : /ac/.test(wifi) ? 'Wi-Fi 5' : wifi ? 'Wi-Fi 4' : '';
  const bt = (S.bluetooth || get('Comms', 'Bluetooth')).match(/[\d.]+/)?.[0];
  const nfc = (S.nfc || get('Comms', 'NFC')).toLowerCase();
  const simTxt = (S.sim || get('Body', 'SIM') || '').toLowerCase();
  const sim = /dual|\+/.test(simTxt) ? 'Dual SIM' : '';
  out.network = [gen, sim, wifiGen, bt && `BT ${bt}`, nfc ? (nfc.startsWith('yes') ? 'NFC' : '') : ''].filter(Boolean).join(', ');
  if (!out.network) delete out.network;

  const slot = S.memoryslot || get('Memory', 'Card slot');
  if (slot) out.expandable = /^no/i.test(slot) ? 'No' : `Yes, ${slot.replace(/\s+/g, ' ')}`;

  return out;
}

export async function readPhone(url: string, title: string) {
  const html = await politeGet(url);
  const parsed = parseSpecPage(html);
  return { specs: toSheet(parsed, title), name: parsed.name };
}

export const isGsmArena = (url: string) => /(^|\.)gsmarena\.com$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());
