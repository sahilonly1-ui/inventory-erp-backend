// Reads Drik Panchang's monthly festival pages
// (https://www.drikpanchang.com/festivals/month/festivals-<month>.html?year=YYYY): every
// event card on the page, with its date. Pure parsing — no network here.

export interface DrikEvent {
  day: string;        // YYYY-MM-DD
  name: string;       // "Guru Nanak Jayanti"
  kind: string;       // the card's colour class without "dp"/"EventColor": Hindu, Sikh, Govt…
  detail: string;     // "Kartika, Shukla Purnima" / "based on Jain calendar"
  href: string;       // Drik Panchang page for the event
}

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const drikMonthUrl = (year: number, month0: number) =>
  `https://www.drikpanchang.com/festivals/month/festivals-${MONTHS[month0]}.html?year=${year}`;

const decode = (s: string) => s
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function isoDay(text: string): string | null {
  // "November 24, 2026, Tuesday"
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function parseDrikMonth(html: string): DrikEvent[] {
  const out: DrikEvent[] = [];
  const seen = new Set<string>();
  // <a href="…" class="dpEvent…"> … <div class="dpEventName dpHinduEventColor">Name</div>
  //   <div class="dpEventGregDate">November 24, 2026, Tuesday</div>Kartika, Shukla Purnima</div></a>
  const re = /<a\s+href="([^"]*)"\s+class="dpEvent[^"]*"[\s\S]*?<div class="dpEventName([^"]*)">([\s\S]*?)<\/div>\s*<div class="dpEventGregDate">([\s\S]*?)<\/div>([\s\S]*?)<\/div>\s*<\/a>/g;
  for (const m of html.matchAll(re)) {
    const name = decode(m[3].replace(/<[^>]+>/g, ''));
    const day = isoDay(decode(m[4]));
    if (!name || !day) continue;
    const kind = (m[2].match(/dp([A-Za-z]+)EventColor/) || [])[1] || '';
    const key = `${day}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, name, kind, detail: decode(m[5].replace(/<[^>]+>/g, '')).slice(0, 120), href: m[1].slice(0, 300) });
  }
  return out;
}
