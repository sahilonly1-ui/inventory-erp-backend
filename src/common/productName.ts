import { prisma } from '../config/prisma';

/**
 * Cleans a product name before it is saved:
 *  - trims and collapses double/multiple spaces
 *  - tidies spacing around brackets and commas: "( Black )" → "(Black)", "Black ,Blue" → "Black, Blue"
 *  - drops an accidentally repeated word: "Black Black" → "Black"
 *  - fixes simple one-letter spelling slips ("Wirless" → "Wireless", "Blck" → "Black") by
 *    matching against words already used across the product catalogue, plus a base list.
 *
 * Model codes and anything containing a digit (8/128GB, ES20, MQD83HN/A) are never touched,
 * and short words (< 4 letters) are left alone so abbreviations aren't "corrected".
 */

const BASE_WORDS = `
black white blue green grey gray silver gold rose pink purple violet red orange yellow
brown beige cream navy teal mint lavender midnight starlight graphite titanium natural
charcoal coral olive maroon peach aqua jet matte glossy frost pristine sparkling bronze
sand dune lime khaki ivory pearl onyx obsidian slate stone ash smoke cyan magenta lilac
copper champagne camo squad desert ocean sky forest moss sage blush ruby jade amber
wireless wired bluetooth earbuds earphone earphones headphone headphones headset neckband
neckbands speaker speakers charger charging adapter cable cover case tempered glass screen
protector power bank smartwatch watch strap band phone smartphone tablet laptop keyboard
mouse stand holder mount tripod selfie stick memory card pendrive portable fast true noise
cancelling canceling active buds pro max plus lite mini ultra edition generation series
dual type micro lightning magnetic magsafe wall car travel desktop sound bar soundbar
gaming tws over ear in-ear clip ring light fusion edge neo air
`.split(/\s+/).filter(Boolean);

type Vocab = { freq: Map<string, number>; canon: Map<string, string> };
let cache: { at: number; vocab: Vocab } | null = null;
const TTL_MS = 10 * 60 * 1000;

function addWords(v: Vocab, text: string, weight = 1) {
  for (const tok of text.split(/\s+/)) {
    if (/\d/.test(tok)) continue;
    for (const w of tok.match(/[A-Za-z]+/g) || []) {
      const k = w.toLowerCase();
      v.freq.set(k, (v.freq.get(k) || 0) + weight);
    }
  }
}

export async function loadNameVocab(force = false): Promise<Vocab> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.vocab;
  const v: Vocab = { freq: new Map(), canon: new Map() };
  for (const w of BASE_WORDS) v.freq.set(w, (v.freq.get(w) || 0) + 5);
  const [products, brands] = await Promise.all([
    prisma.product.findMany({ where: { isDeleted: false }, select: { model: true } }),
    prisma.brand.findMany({ where: { isDeleted: false }, select: { name: true } }),
  ]);
  for (const p of products) addWords(v, p.model || '');
  for (const b of brands) {
    const name = (b.name || '').trim();
    if (!name || /\d/.test(name) || /\s/.test(name)) continue;
    v.canon.set(name.toLowerCase(), name);             // brand casing: "samsung" → "Samsung"
    v.freq.set(name.toLowerCase(), (v.freq.get(name.toLowerCase()) || 0) + 20);
  }
  cache = { at: Date.now(), vocab: v };
  return v;
}

/** Words one edit away (delete, transpose, replace, insert). */
function edits1(w: string): string[] {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  const out: string[] = [];
  for (let i = 0; i <= w.length; i++) {
    const L = w.slice(0, i), R = w.slice(i);
    if (R) out.push(L + R.slice(1));                                 // delete
    if (R.length > 1) out.push(L + R[1] + R[0] + R.slice(2));        // transpose
    for (const c of a) {
      if (R) out.push(L + c + R.slice(1));                           // replace
      out.push(L + c + R);                                           // insert
    }
  }
  return out;
}

function matchCase(original: string, fixed: string): string {
  if (original === original.toUpperCase()) return fixed.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1);
  return fixed;
}

const COLOURS = new Set(BASE_WORDS.slice(0, BASE_WORDS.indexOf('wireless')));

function fixWord(word: string, v: Vocab, inBrackets = false): string {
  const k = word.toLowerCase();
  if (v.canon.has(k) && word !== word.toUpperCase()) return v.canon.get(k)!;
  // Only clear typos are touched: 5+ letters, never seen before anywhere.
  // Shorter words ("Sand", "Dune", "Bend") are too often a real, rare word that
  // sits one letter away from a common one ("Band") — those must be left alone.
  if (k.length < 5) return word;
  if (word.length > 1 && word === word.toUpperCase()) return word;   // acronyms / codes: TWS, ANC, USB
  if (/[A-Z]/.test(word.slice(1))) return word;                     // brand styling: iPhone, AirPods, OnePlus
  const own = v.freq.get(k) || 0;
  if (own > 0) return word;                       // already used in the catalogue = a real word
  if (inBrackets && COLOURS.has(k)) return word;
  let best = '', bestF = 0, rivals = 0;
  for (const c of new Set(edits1(k))) {
    const f = v.freq.get(c) || 0;
    // Inside brackets (colour / variant) only correct towards a known colour.
    if (!f || (inBrackets && !COLOURS.has(c))) continue;
    rivals++;
    if (f > bestF) { best = c; bestF = f; }
  }
  // Exactly one plausible, clearly common word — otherwise it's a guess, so leave it.
  if (best && rivals === 1 && bestF >= 5) return v.canon.get(best) ?? matchCase(word, best);
  return word;
}

/** Whitespace / punctuation tidy-up only (no spelling). Safe to run anywhere. */
export function tidyProductName(raw: string): string {
  let s = String(raw ?? '').replace(/[\u00A0\t\r\n]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  s = s.replace(/\[\s+/g, '[').replace(/\s+\]/g, ']');
  s = s.replace(/\s+,/g, ',').replace(/,(?=\S)/g, ', ');
  s = s.replace(/(\S)\(/g, '$1 (');                       // "Buds(Black)" → "Buds (Black)"
  s = s.replace(/\b([A-Za-z]{2,})(\s+\1\b)+/gi, '$1');    // "Black Black" → "Black"
  return s.replace(/\s+/g, ' ').trim();
}

export function normalizeProductNameWith(raw: string, v: Vocab): string {
  const tidy = tidyProductName(raw);
  let depth = 0;
  return tidy.split(' ').map(tok => {
    const inBr = depth > 0 || tok.startsWith('(');
    depth += (tok.match(/\(/g) || []).length - (tok.match(/\)/g) || []).length;
    if (depth < 0) depth = 0;
    if (/\d/.test(tok)) return tok;                       // model codes, storage sizes
    return tok.replace(/[A-Za-z]+/g, w => fixWord(w, v, inBr));
  }).join(' ');
}

export async function normalizeProductName(raw: string): Promise<string> {
  const tidy = tidyProductName(raw);
  try {
    return normalizeProductNameWith(tidy, await loadNameVocab());
  } catch {
    return tidy;                                          // never block a save on the spell-check
  }
}
