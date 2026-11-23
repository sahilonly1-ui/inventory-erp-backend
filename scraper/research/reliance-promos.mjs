// Structure of Reliance's /ext/raven-api/promotions answer (minus EMI tables), as the product page gets it.
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const QS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
const home = await context.newPage();
await home.goto('https://www.reliancedigital.in/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
await home.waitForTimeout(4000);
for (const q of QS) {
  const slug = await home.evaluate(async q => {
    const j = await fetch(`/ext/raven-api/catalog/v1.0/products?q=${encodeURIComponent(q)}&page_id=*&page_no=1&page_size=3&page_type=number`, { headers: { accept: 'application/json' } }).then(r => r.json());
    return j.items?.[0]?.slug;
  }, q).catch(() => null);
  if (!slug) continue;
  const page = await context.newPage();
  let got = null;
  page.on('response', async resp => {
    if (!/\/ext\/raven-api\/promotions\?/.test(resp.url()) || got) return;
    try { const j = await resp.json(); const d = { ...(j.data || {}) }; delete d.emi_data; got = { u: resp.url().slice(0, 140), d: JSON.stringify(d).slice(0, 5000) }; } catch { }
  });
  await page.goto(`https://www.reliancedigital.in/product/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 12 && !got; i++) await page.waitForTimeout(1000);
  console.log('PROBE ' + JSON.stringify({ q, slug, ...got }));
  await page.close();
}
await browser.close();
