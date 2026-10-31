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
let modelCache: { at: number; name: string } | null = null;
async function geminiModel(): Promise<string> {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (modelCache && Date.now() - modelCache.at < 6 * 3600_000) return modelCache.name;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI_KEY()}`);
    const d: any = await r.json();
    const names: string[] = (d.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''))
      .filter((n: string) => /^gemini-[\d.]+-flash(-\d+)?$/i.test(n) || /^gemini-[\d.]+-flash-latest$/i.test(n));
    const ver = (n: string) => parseFloat(n.match(/gemini-([\d.]+)/)?.[1] ?? '0');
    names.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    if (names[0]) { modelCache = { at: Date.now(), name: names[0] }; return names[0]; }
  } catch (e: any) { logger.warn({ msg: e?.message }, 'gemini model list failed'); }
  return 'gemini-flash-latest';
}

class AiError extends Error { constructor(msg: string, public kind: 'grounding' | 'quota' | 'other') { super(msg); } }

async function gemini(prompt: string, withSearch: boolean): Promise<string> {
  const model = await geminiModel();
  const body: any = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } };
  if (withSearch) body.tools = [{ google_search: {} }];
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY() }, body: JSON.stringify(body),
    });
    const d: any = await r.json().catch(() => ({}));
    if (r.ok) return (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('\n');
    const msg = String(d?.error?.message || `Gemini error ${r.status}`);
    if (withSearch && (r.status === 400 || r.status === 403 || /search|ground|tool/i.test(msg) || /limit: ?0/i.test(msg))) {
      throw new AiError(msg, 'grounding');
    }
    if (r.status === 429) {
      if (/per ?day|daily|RPD/i.test(msg) || attempt === 2) throw new AiError('Free AI daily limit reached — will continue automatically later.', 'quota');
      await new Promise(res => setTimeout(res, 20_000 * (attempt + 1)));   // per-minute limit: wait and retry
      continue;
    }
    throw new AiError(msg, 'other');
  }
  throw new AiError('Gemini did not answer', 'other');
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

const SKIP = /youtube\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|quora\.com|pinterest\./i;
async function searchLinks(query: string): Promise<string[]> {
  const links: string[] = [];
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA } });
    const html = await r.text();
    for (const m of html.matchAll(/class="result__a"[^>]*href="([^"]+)"/g)) {
      let u = m[1];
      const uddg = u.match(/[?&]uddg=([^&]+)/)?.[1];
      if (uddg) u = decodeURIComponent(uddg);
      if (u.startsWith('//')) u = 'https:' + u;
      if (/^https?:\/\//.test(u) && !SKIP.test(u) && !/duckduckgo\.com/.test(u)) links.push(u);
    }
  } catch { /* try Bing */ }
  if (links.length < 2) {
    try {
      const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-IN`, { headers: { 'user-agent': UA } });
      const html = await r.text();
      for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"/g)) {
        if (!SKIP.test(m[1]) && !/bing\.com|microsoft\.com/.test(m[1])) links.push(m[1]);
      }
    } catch { /* nothing */ }
  }
  return [...new Set(links)].slice(0, 6);
}

/**
 * Ask the AI for specs. `prompt` describes the JSON wanted. With search, the
 * model looks things up itself (grounding) or we hand it the top pages.
 */
export async function askForSpecs(prompt: string, opts: { search: boolean; query?: string; site?: string; pageText?: string; pageUrl?: string }): Promise<{ text: string; sources: string[] }> {
  const p = aiProvider();
  if (!p) throw new AiError('No AI key set on the server.', 'other');
  const call = p === 'gemini' ? gemini : claude;

  if (opts.pageText) {
    return { text: await call(`${prompt}\n\nRead the specifications ONLY from this page (${opts.pageUrl}):\n"""${opts.pageText.slice(0, 60_000)}"""`, false), sources: opts.pageUrl ? [opts.pageUrl] : [] };
  }
  if (!opts.search) return { text: await call(prompt, false), sources: [] };

  if (!opts.site) {
    try { return { text: await call(prompt, true), sources: [] }; }
    catch (e: any) {
      if (!(e instanceof AiError) || e.kind !== 'grounding') throw e;
      logger.info({ msg: e.message }, 'spec fetch: grounding unavailable, using own web search');
    }
  }
  // Own search: read the top results and give their text to the AI.
  const q = `${opts.query ?? ''} specifications${opts.site ? ` site:${opts.site}` : ''}`;
  const links = await searchLinks(q);
  const pages: string[] = []; const used: string[] = [];
  for (const u of links) {
    const t = await getPage(u);
    if (t.length > 800) { pages.push(`SOURCE ${u}\n${t.slice(0, 15_000)}`); used.push(u); }
    if (pages.length >= 3) break;
  }
  if (!pages.length) throw new AiError('Could not find any page with these specifications.', 'other');
  const text = await call(`${prompt}\n\nUse ONLY these pages. Put the URLs you used in "sources".\n\n${pages.join('\n\n---\n\n')}`, false);
  return { text, sources: used };
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
