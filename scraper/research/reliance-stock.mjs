// Reliance: which data says "Currently unavailable online" for a product.
process.env.SCRAPER_TEST = '1';
const { launch, scrapeStore } = await import('../index.mjs');
const QS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
const home = await context.newPage();
await home.goto('https://www.reliancedigital.in/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await home.waitForTimeout(4000);
for (const q of QS) {
  const items = await home.evaluate(async q => {
    const j = await fetch(`/ext/raven-api/catalog/v1.0/products?q=${encodeURIComponent(q)}&page_id=*&page_no=1&page_size=4&page_type=number`, { headers: { accept: 'application/json' } }).then(r => r.json());
    return (j.items || []).map(x => ({ name: x.name.slice(0, 70), slug: x.slug, sellable: x.sellable, keys: Object.keys(x).filter(k => /avail|stock|sell|inventory|online|deliver/i.test(k)).map(k => `${k}=${JSON.stringify(x[k]).slice(0, 60)}`) }));
  }, q).catch(e => [{ err: e.message }]);
  console.log('PROBE ' + JSON.stringify({ q, items }));
  for (const it of items.filter(i => /l9ehl3|cream-m1p25z/.test(i.slug || '')).concat(items.slice(0, 0))) {
    if (!it.slug) continue;
    const det = await home.evaluate(async slug => {
      const a = await fetch(`/ext/raven-api/catalog/v1.0/products/${slug}/sizes`, { headers: { accept: 'application/json' } }).then(r => r.text()).catch(e => 'ERR ' + e.message);
      return (a.match(/"(sellable|is_available|quantity|is_serviceable|available)"\s*:\s*[^,}]{1,20}/g) || []).slice(0, 12);
    }, it.slug);
    const url = `https://www.reliancedigital.in/product/${it.slug}`;
    const r = await scrapeStore(context, { itemId: 't', name: it.name, brand: q.split(' ')[0], variant: null, stores: [] }, { store: 'reliance', url, locked: true }).catch(e => ({ err: e.message }));
    console.log('PROBE ' + JSON.stringify({ slug: it.slug, sizes: det, status: r.status, price: r.price, inStock: r.inStock, why: r.stockWhy, note: r.note, keys: Object.keys(r).join(',') }));
  }
}
await browser.close();
