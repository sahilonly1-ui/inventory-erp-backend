import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { drikMonthUrl, parseDrikMonth, type DrikEvent } from './drik';

const q = <T = any>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const x = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p);

// How far ahead the calendar is kept (months, counting the current one).
const AHEAD = 14;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36';

/** Year and month (0-based) in India now. */
function indiaYm(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(d);
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) - 1 };
}

async function fetchMonth(y: number, m: number): Promise<DrikEvent[]> {
  const res = await fetch(drikMonthUrl(y, m), {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Drik Panchang ${y}-${m + 1}: HTTP ${res.status}`);
  const all = parseDrikMonth(await res.text());
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  return all.filter(e => e.day.startsWith(prefix));
}

/** Replaces one month's events — only when the page gave a sensible list. */
async function saveMonth(y: number, m: number, events: DrikEvent[]) {
  if (events.length < 5) throw new Error(`Drik Panchang ${y}-${m + 1}: only ${events.length} events read — kept the old list`);
  const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`DELETE FROM festive_events WHERE day >= $1::date AND day < ($1::date + interval '1 month')`, from),
    prisma.$executeRawUnsafe(
      `INSERT INTO festive_events (day, name, kind, detail, href)
       SELECT (e->>'day')::date, e->>'name', e->>'kind', e->>'detail', e->>'href' FROM jsonb_array_elements($1::jsonb) e
       ON CONFLICT (day, name) DO NOTHING`, JSON.stringify(events)),
  ]);
}

let running = false;
/** Fetches this month and the next ones from Drik Panchang. */
export async function syncFromDrik(): Promise<{ months: number; events: number; errors: string[] }> {
  if (running) return { months: 0, events: 0, errors: ['already running'] };
  running = true;
  const errors: string[] = [];
  let months = 0, events = 0;
  try {
    const { y, m } = indiaYm();
    for (let i = 0; i < AHEAD; i++) {
      const yy = y + Math.floor((m + i) / 12), mm = (m + i) % 12;
      try {
        const ev = await fetchMonth(yy, mm);
        // A month far ahead may not be published yet; that is not an error worth keeping.
        if (ev.length < 5 && i > 2) continue;
        await saveMonth(yy, mm, ev);
        months++; events += ev.length;
      } catch (e: any) { errors.push(e?.message || String(e)); }
      await new Promise(r => setTimeout(r, 1500));   // gentle on their server
    }
    await x(`INSERT INTO festive_sync (key, value, "updatedAt") VALUES ('drik', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`, JSON.stringify({ months, events, errors }));
    logger.info({ months, events, errors }, 'Festive calendar synced from Drik Panchang');
  } finally { running = false; }
  return { months, events, errors };
}

export async function events(from: string, to: string) {
  return q<{ day: string; name: string; kind: string; detail: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS "day", name, kind, detail FROM festive_events
     WHERE day BETWEEN $1::date AND $2::date ORDER BY day, name`, from, to);
}

export async function status() {
  const [s] = await q(`SELECT value, "updatedAt" FROM festive_sync WHERE key='drik'`);
  const [c] = await q(`SELECT count(*)::int n, to_char(min(day),'YYYY-MM-DD') "from", to_char(max(day),'YYYY-MM-DD') "to" FROM festive_events`);
  return { last: s ?? null, ...c };
}

/** Keeps the calendar fresh: shortly after start, then every 12 hours if a day has passed. */
export function startFestiveSync() {
  const tick = async () => {
    try {
      const [s] = await q(`SELECT "updatedAt" FROM festive_sync WHERE key='drik' AND "updatedAt" > now() - interval '20 hours'`);
      if (!s) await syncFromDrik();
    } catch (e: any) { logger.warn({ msg: e?.message }, 'Festive calendar sync failed'); }
  };
  setTimeout(tick, 90_000).unref();
  setInterval(tick, 12 * 3600_000).unref();
}
