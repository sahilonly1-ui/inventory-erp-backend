// All events (day + name) for the next 14 months, compact.
const M = ['january','february','march','april','may','june','july','august','september','october','november','december'];
for (let i = 0; i < 14; i++) {
  const yy = 2026 + Math.floor((10 + i) / 12), mm = (10 + i) % 12;
  const t = await (await fetch(`https://www.drikpanchang.com/festivals/month/festivals-${M[mm]}.html?year=${yy}`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36' } })).text();
  const out = [];
  for (const x of t.matchAll(/<div class="dpEventName[^"]*">([\s\S]*?)<\/div>\s*<div class="dpEventGregDate">([^<]*)<\/div>/g)) {
    const m = x[2].match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/); if (!m) continue;
    out.push(`${m[3]}-${String(M.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}|${x[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim()}`);
  }
  console.log('PROBE ' + JSON.stringify(out));
  await new Promise(r => setTimeout(r, 1200));
}
