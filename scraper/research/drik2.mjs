// Drik Panchang page HTML around events + section headers.
const URLS = JSON.parse(process.env.SITES || '[]');
for (const u of URLS) {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36', accept: 'text/html' } });
  const t = await r.text();
  const i = t.indexOf('Rama Ekadashi');
  console.log('PROBE ' + JSON.stringify({ u, status: r.status, around: t.slice(i - 2500, i + 1200) }));
  const heads = [...t.matchAll(/<(h2|h3|div)[^>]*class="([^"]*(Title|Header|Heading)[^"]*)"[^>]*>([^<]{3,120})</g)].map(m => `${m[2]} :: ${m[4]}`).slice(0, 60);
  console.log('PROBE ' + JSON.stringify({ heads }));
  const gi = t.indexOf('Government Holidays', t.indexOf('2026 November Hindu Festivals'));
  console.log('PROBE ' + JSON.stringify({ tail: t.slice(t.lastIndexOf('Anvadhan') - 200, t.lastIndexOf('Anvadhan') + 4000) }));
}
