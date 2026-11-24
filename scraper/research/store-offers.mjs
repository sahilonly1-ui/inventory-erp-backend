// End-to-end: the scraper's own store read for given pages; prints price, stock and offers.
process.env.SCRAPER_TEST = '1';
const { launch, scrapeStore } = await import('../index.mjs');
const JOBS = JSON.parse(process.env.SITES || '[]');   // [{store, url, name, brand}]
const { browser, context } = await launch();
for (const j of JOBS) {
  const job = { itemId: 't', name: j.name, brand: j.brand, variant: null, stores: [{ store: j.store, url: j.url, locked: true }] };
  const r = await scrapeStore(context, job, { store: j.store, url: j.url, locked: true }).catch(e => ({ err: e.message }));
  console.log('PROBE ' + JSON.stringify({ name: j.name, store: j.store, status: r.status, price: r.price, inStock: r.inStock, note: r.note, offers: (r.offers || []).map(o => `${o.bank}|${o.cardType}|${o.offerType}|${o.mode}|amt ${o.amount}|${o.percent}%|max ${o.maxDiscount}|min ${o.minTxn}`) }));
}
await browser.close();
