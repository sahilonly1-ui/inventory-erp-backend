// Brand-site test: find each product on its brand store and read the price, exactly as the scraper does.
process.env.SCRAPER_TEST = '1';
if (!process.env.GOOGLE) process.env.GOOGLE = '0';     // test the brand-site route on its own
const { launch, scrapeStore } = await import('../index.mjs');
const JOBS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
let i = 0;
const run = async () => {
  for (;;) {
    const j = JOBS[i++]; if (!j) return;
    const t = Date.now();
    const job = { itemId: 'test', name: j.name, brand: j.brand, variant: null, ean: null, stores: [] };
    const s = { store: 'official', officialSite: j.site, url: j.url || null, locked: !!j.url };
    job.stores = [s];
    let r;
    try { r = await scrapeStore(context, job, s); } catch (e) { r = { status: 'crash', note: e.message }; }
    console.log('PROBE ' + JSON.stringify({ name: j.name, site: j.site, secs: Math.round((Date.now() - t) / 1000), status: r.status, price: r.price, mrp: r.mrp, inStock: r.inStock, url: r.url, title: String(r.title || '').slice(0, 70), note: String(r.note || '').slice(0, 220) }));
  }
};
await Promise.all([run(), run(), run(), run()]);
await browser.close();
