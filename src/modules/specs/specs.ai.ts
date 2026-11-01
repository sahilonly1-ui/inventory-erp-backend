import { logger } from '../../config/logger';

/*
 * AI for specs of non-phone categories (and phones GSMArena doesn't have).
 *
 * Primary: Google Gemini on the free tier (GEMINI_API_KEY from aistudio.google.com).
 *  - First try with Google Search grounding.
 *  - If grounding isn't available on the key's tier, do the web search
 *    ourselves (DuckDuckGo, then Bing), read the top pages, and let Gemini
 *    extract the specs from that text. Plain text requests are free.
 * Optional: Claude, only if ANTHROPIC_API_KEY is set and Gemini isn't.
 *
 * The free tier has small per-minute / per-day limits, so calls are made one
 * at a time; a daily-limit error is reported and retried later.
 */

const GEMINI_KEY = () => process.env.GEMINI_API_KEY || '';
const CLAUDE_KEY = () => process.env.ANTHROPIC_API_KEY || '';
export const aiProvider = (): 'gemini' | 'claude' | null => GEMINI_KEY() ? 'gemini' : CLAUDE_KEY() ? 'claude' : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ── Gemini model choice ───────────────────────────────────────────────────
// Google renames / retires models often, so pick from what the key can see:
// the newest plain "Flash" text model (free tier), not Pro / image / TTS / live.
let modelCache: { at: number; names: string[] } | null = null;
async function geminiModels(): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (modelCache && Date.now() - modelCache.at < 6 * 3600_000) return modelCache.names;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI_KEY()}`);
    const d: any = await r.json();
    const all: string[] = (d.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''));
    const ver = (n: string) => parseFloat(n.match(/gemini-([\d.]+)/)?.[1] ?? '0');
    const flash = all.filter(n => /^gemini-[\d.]+-flash$/i.test(n)).sort((a, b) => ver(b) - ver(a));
    const lite = all.filter(n => /^gemini-[\d.]+-flash-lite$/i.test(n)).sort((a, b) => ver(b) - ver(a));
    // Newest Flash first, then older Flash, then Flash-Lite — used in turn when one is overloaded.
    const names = [...flash.slice(0, 3), ...lite.slice(0, 2)];
    if (names.length) { modelCache = { at: Date.now(), names }; return names; }
  } catch (e: any) { logger.warn({ msg: e?.message }, 'gemini model list failed'); }
  return ['gemini-flash-latest'];
}
async function geminiModel(): Promise<string> { return (await geminiModels())[0]; }

class AiError extends Error { constructor(msg: string, public kind: 'grounding' | 'quota' | 'tool' | 'other') { super(msg); } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Free keys usually get no Google Search quota. Once we see that, stop trying
// grounding for a day and go straight to our own search + plain Gemini.
let groundingOffUntil = 0;
export const groundingAvailable = () => Date.now() >= groundingOffUntil;

async function gemini(prompt: string, withSearch: boolean, extraTools?: any[]): Promise<string> {
  if (withSearch && !groundingAvailable()) throw new AiError('Google Search grounding not available on this key', 'grounding');
  const models = await geminiModels();
  const body: any = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } };
  if (withSearch) body.tools = [{ google_search: {} }];
  else if (extraTools?.length) body.tools = extraTools;
  let lastMsg = 'Gemini did not answer';
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY() }, body: JSON.stringify(body),
      });
      const d: any = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('\n');
        if (text.trim()) return text;
        lastMsg = 'Gemini returned an empty answer'; break;
      }
      const msg = String(d?.error?.message || `Gemini error ${r.status}`);
      lastMsg = msg;
      if (withSearch && (r.status === 400 || r.status === 403 || r.status === 429 || /search|ground/i.test(msg))) {
        groundingOffUntil = Date.now() + 24 * 3600_000;
        throw new AiError(msg, 'grounding');
      }
      if (extraTools?.length && (r.status === 400 || r.status === 403 || (r.status === 429 && /limit: ?0/i.test(msg)))) {
        throw new AiError(msg, 'tool');
      }
      if (r.status >= 500) { await sleep(4000 * (attempt + 1)); continue; }          // overloaded: wait, retry
      if (r.status === 429) {
        if (/per ?day|daily|RPD|PerDay/i.test(msg)) break;                           // this model's day is used up: next model
        await sleep(20_000 * (attempt + 1)); continue;                               // per-minute limit
      }
      if (r.status === 404) break;                                                    // model gone: next one
      throw new AiError(msg, 'other');
    }
  }
  if (/per ?day|daily|RPD|PerDay|quota/i.test(lastMsg)) throw new AiError('Free AI daily limit reached — will continue automatically later.', 'quota');
  throw new AiError(lastMsg, 'other');
}

async function claude(prompt: string, withSearch: boolean): Promise<string> {
  const body: any = { model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] };
  if (withSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': CLAUDE_KEY(), 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new AiError(d?.error?.message || `AI request failed (${r.status})`, r.status === 429 ? 'quota' : 'other');
  return (d.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
}

// ── Our own web search (used when grounding isn't available) ──────────────
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

export async function getPage(url: string): Promise<string> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    return r.ok ? stripHtml(await r.text()) : '';
  } catch { return ''; } finally { clearTimeout(t); }
}

const SKIP = /youtube\.com|facebook\.com|instagram\.com|twitter\.com|\bx\.com|reddit\.com|quora\.com|pinterest\./i;
// Sites that refuse servers (Cloudflare) — their search snippets are still used, the page isn't fetched.
const UNREADABLE = /gsmarena\.com|91mobiles\.com|flipkart\.com|amazon\.in|amazon\.com|smartprix\.com/i;

export type WebResult = { url: string; title: string; snippet: string };

/** Bing hides each result behind bing.com/ck/a?…&u=a1<base64url>. Unwrap it. */
function unwrapBing(href: string): string {
  const h = href.replace(/&amp;/g, '&');
  const u = h.match(/[?&]u=a1([^&]+)/)?.[1];
  if (u) {
    try { return Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* keep */ }
  }
  return h;
}
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&#0?39;/g, "'").replace(/&middot;|&#183;/g, '·').replace(/\s+/g, ' ').trim();

export async function webSearch(query: string): Promise<WebResult[]> {
  const out: WebResult[] = [];
  try {
    const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-IN&cc=IN&count=15`, {
      headers: { 'user-agent': UA, 'accept-language': 'en-IN,en;q=0.9', accept: 'text/html' },
    });
    const html = await r.text();
    for (const block of html.split('<li class="b_algo"').slice(1)) {
      const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;
      const url = unwrapBing(a[1]);
      if (!/^https?:\/\//.test(url) || SKIP.test(url) || /bing\.com|microsoft\.com/.test(url)) continue;
      const snip = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]
        ?? block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';
      out.push({ url, title: text(a[2]), snippet: text(snip).slice(0, 400) });
    }
  } catch (e: any) { logger.warn({ msg: e?.message }, 'bing search failed'); }
  if (out.length < 2) {
    try {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA } });
      if (r.status === 200) {
        const html = await r.text();
        for (const m of html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
          let u = m[1]; const uddg = u.match(/[?&]uddg=([^&]+)/)?.[1]; if (uddg) u = decodeURIComponent(uddg);
          if (u.startsWith('//')) u = 'https:' + u;
          if (/^https?:\/\//.test(u) && !SKIP.test(u)) out.push({ url: u, title: text(m[2]), snippet: text(m[3]).slice(0, 400) });
        }
      }
    } catch { /* nothing */ }
  }
  const seen = new Set<string>();
  return out.filter(r => !seen.has(r.url) && seen.add(r.url)).slice(0, 12);
}

/** Read a page: directly, else through the free Jina reader (renders JS pages). */
export async function readPage(url: string): Promise<string> {
  const direct = await getPage(url);
  if (direct.length > 1500 && !/Turnstile|Attention Required|Just a moment|Access denied/i.test(direct.slice(0, 600))) return direct;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25_000);
    const r = await fetch(`https://r.jina.ai/${url}`, { headers: { 'user-agent': UA, accept: 'text/plain' }, signal: ctrl.signal });
    clearTimeout(t);
    const body = await r.text();
    if (r.ok && body.length > 1500 && !/Turnstile|Attention Required|Just a moment|returned error 40/i.test(body.slice(0, 600))) return body.replace(/\s+/g, ' ');
  } catch { /* unreadable */ }
  return '';
}

/** Ask Gemini to read a URL itself (Google fetches it). Not every key/tier allows it. */
let urlToolOffUntil = 0;
export async function askWithUrl(prompt: string, url: string): Promise<string | null> {
  if (aiProvider() !== 'gemini' || Date.now() < urlToolOffUntil) return null;
  try { return await gemini(`${prompt}\n\nRead the specifications from this page: ${url}`, false, [{ url_context: {} }]); }
  catch (e: any) {
    if (e instanceof AiError && e.kind === 'tool') urlToolOffUntil = Date.now() + 24 * 3600_000;
    if (e instanceof AiError && e.kind === 'quota') throw e;
    return null;
  }
}

/**
 * Research a product with our own search: Bing results (titles + snippets, which
 * already carry most specs) plus the text of a few readable pages, then let the
 * AI pick out the specs. One AI request per product.
 */
export async function askForSpecs(prompt: string, opts: { search: boolean; query?: string; site?: string; pageText?: string; pageUrl?: string; queries?: string[] }): Promise<{ text: string; sources: string[] }> {
  const p = aiProvider();
  if (!p) throw new AiError('No AI key set on the server.', 'other');
  const call = (q: string) => p === 'gemini' ? gemini(q, false) : claude(q, false);

  if (opts.pageText) {
    return { text: await call(`${prompt}\n\nRead the specifications ONLY from this page (${opts.pageUrl}):\n"""${opts.pageText.slice(0, 60_000)}"""`), sources: opts.pageUrl ? [opts.pageUrl] : [] };
  }
  if (!opts.search) return { text: await call(prompt), sources: [] };

  // Grounding first when the key has it (paid keys); free keys skip straight on.
  if (!opts.site && p === 'gemini' && groundingAvailable()) {
    try { return { text: await gemini(prompt, true), sources: [] }; }
    catch (e: any) { if (!(e instanceof AiError) || e.kind !== 'grounding') throw e; }
  } else if (!opts.site && p === 'claude') {
    return { text: await claude(prompt, true), sources: [] };
  }

  const base = opts.query ?? '';
  const queries = opts.queries?.length ? opts.queries
    : opts.site ? [`site:${opts.site} ${base}`, `${base} specifications`]
    : [`${base} specifications`, `${base} full specs price in India`];
  const results: WebResult[] = [];
  for (const q of queries) {
    for (const r of await webSearch(q)) if (!results.some(x => x.url === r.url)) results.push(r);
    if (results.length >= 8) break;
  }
  if (!results.length) throw new AiError('Web search returned nothing for this model.', 'other');

  const pages: string[] = []; const used: string[] = [];
  for (const r of results) {
    if (pages.length >= 2) break;
    if (UNREADABLE.test(r.url)) continue;
    const t = await readPage(r.url);
    if (t.length > 1500) { pages.push(`PAGE ${r.url}\n${t.slice(0, 14_000)}`); used.push(r.url); }
  }
  const snippets = results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.snippet}`).join('\n');
  const text = await call(`${prompt}

You have web search results (titles + snippets) and the text of some pages below. Use ONLY this material.
Prefer the manufacturer's site, GSMArena, 91mobiles, Smartprix, Gadgets360. If the material does not
clearly describe this exact model, set "found": false. Put the URLs you relied on in "sources".

SEARCH RESULTS:
${snippets}

${pages.join('\n\n---\n\n')}`);
  return { text, sources: used.length ? used : results.slice(0, 3).map(r => r.url) };
}

export async function askPlain(prompt: string): Promise<string> {
  const p = aiProvider();
  if (!p) throw new Error('No AI key set on the server.');
  return p === 'gemini' ? gemini(prompt, false) : claude(prompt, false);
}

// After boot, confirm the AI key works so the logs show it (no customer data sent).
setTimeout(async () => {
  if (!GEMINI_KEY()) return;
  try {
    const model = await geminiModel();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY() },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }),
    });
    const d: any = await r.json().catch(() => ({}));
    logger.info({ model, status: r.status, reply: d?.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 20), error: d?.error?.message?.slice(0, 200) }, 'Gemini key check');

  } catch (e: any) { logger.warn({ msg: e?.message }, 'Gemini key check failed'); }
}, 20_000).unref();
