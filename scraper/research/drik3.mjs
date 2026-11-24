// Every distinct event name on Drik Panchang for the next 14 months (vocabulary for themes).
const M = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const names = new Map(); const kinds = new Map();
let y = 2026, m = 10;
for (let i = 0; i < 14; i++) {
  const yy = y + Math.floor((m + i) / 12), mm = (m + i) % 12;
  const r = await fetch(`https://www.drikpanchang.com/festivals/month/festivals-${M[mm]}.html?year=${yy}`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36' } });
  const t = await r.text();
  let n = 0;
  for (const x of t.matchAll(/<div class="dpEventName([^"]*)">([\s\S]*?)<\/div>\s*<div class="dpEventGregDate">([^<]*)<\/div>/g)) {
    n++;
    const nm = x[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
    const base = nm.replace(/\b(Shukla|Krishna)\b/g, '').trim();
    names.set(nm, (names.get(nm) || 0) + 1);
    kinds.set(x[1].trim(), (kinds.get(x[1].trim()) || 0) + 1);
  }
  console.log('PROBE ' + JSON.stringify({ yy, mm: mm + 1, status: r.status, n }));
  await new Promise(r => setTimeout(r, 1200));
}
console.log('PROBE ' + JSON.stringify({ kinds: [...kinds] }));
const list = [...names].sort((a, b) => a[0].localeCompare(b[0]));
for (let i = 0; i < list.length; i += 80) console.log('PROBE ' + JSON.stringify(list.slice(i, i + 80).map(([k, v]) => v > 1 ? `${k}×${v}` : k)));
