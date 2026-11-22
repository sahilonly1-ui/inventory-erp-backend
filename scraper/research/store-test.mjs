// Store test: find each product on a store and read the price, exactly as the scraper does.
process.env.SCRAPER_TEST = '1';
if (!process.env.GOOGLE) process.env.GOOGLE = '0';
const { launch, scrapeStore } = await import('../index.mjs');
const JOBS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
let i = 0;
const run = async () => {
  for (;;) {
    const j = JOBS[i++]; if (!j) return;
    const t = Date.now();
    const job = { itemId: 'test', name: j.name, brand: j.brand, variant: null, ean: null, stores: [] };
    const s = { store: j.store, officialSite: j.site || null, url: j.url || null, locked: !!j.url };
    job.stores = [s];
    let r;
    try { r = await scrapeStore(context, job, s); } catch (e) { r = { status: 'crash', note: e.message }; }
    console.log('PROBE ' + JSON.stringify({ store: j.store, name: j.name, secs: Math.round((Date.now() - t) / 1000), status: r.status, price: r.price, inStock: r.inStock, url: r.url, title: String(r.title || '').slice(0, 70), note: String(r.note || '').slice(0, 400) }));
  }
};
await Promise.all([run(), run(), run()]);
await browser.close();
