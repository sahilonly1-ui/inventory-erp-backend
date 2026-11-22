// Reliance Digital's catalogue API, called from inside its own page (plain requests are refused).
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const QS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
const page = await context.newPage();
await page.goto('https://www.reliancedigital.in/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
await page.waitForTimeout(4000);
for (const q of QS) {
  const r = await page.evaluate(async q => {
    const res = await fetch(`/ext/raven-api/catalog/v1.0/products?q=${encodeURIComponent(q)}&page_id=*&page_no=1&page_size=12&page_type=number`, { headers: { accept: 'application/json' } });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { return { status: res.status, text: t.slice(0, 200) }; }
    const it = j.items || [];
    return { status: res.status, n: it.length, keys: Object.keys(it[0] || {}).join(','), first: JSON.stringify(it[0] || {}).slice(0, 1500),
      list: it.map(x => [x.name, x.slug, JSON.stringify(x.price || {}).slice(0, 160), x.sellable].join(' | ')) };
  }, q).catch(e => ({ e: e.message }));
  console.log('PROBE ' + JSON.stringify({ q, ...r }));
}
await browser.close();
