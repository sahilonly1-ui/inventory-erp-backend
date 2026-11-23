// Structure of Reliance's /ext/raven-api/promotions answer (minus EMI tables).
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const QS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
const page = await context.newPage();
await page.goto('https://www.reliancedigital.in/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
await page.waitForTimeout(4000);
for (const q of QS) {
  const r = await page.evaluate(async q => {
    const res = await fetch(`/ext/raven-api/catalog/v1.0/products?q=${encodeURIComponent(q)}&page_id=*&page_no=1&page_size=3&page_type=number`, { headers: { accept: 'application/json' } });
    const j = await res.json();
    const x = (j.items || [])[0]; if (!x) return { none: 1 };
    const meta = (x._custom_meta || []).filter(m => /offer/.test(m.key));
    const art = x.sizes?.[0]?.article_id || x.article_id || null;
    const keys = Object.keys(x).join(',');
    let promo = null, pk = null, other = null;
    // find article id from product detail
    const d = await fetch(`/ext/raven-api/catalog/v1.0/products/${x.slug}`, { headers: { accept: 'application/json' } }).then(r => r.json()).catch(() => ({}));
    const sizes = await fetch(`/ext/raven-api/catalog/v1.0/products/${x.slug}/sizes`, { headers: { accept: 'application/json' } }).then(r => r.json()).catch(() => ({}));
    const aid = JSON.stringify(sizes).match(/"article_id"\s*:\s*"?(\d+)/)?.[1] || JSON.stringify(d).match(/"article_id"\s*:\s*"?(\d+)/)?.[1] || JSON.stringify(d).match(/"(?:item_code|uid)"\s*:\s*"?(\d+)/)?.[1];
    if (aid) {
      const p = await fetch(`/ext/raven-api/promotions?article-id=${aid}&slug=${x.slug}`, { headers: { accept: 'application/json' } });
      const pj = await p.json().catch(() => null);
      pk = pj && Object.keys(pj.data || {}).join(',');
      const data = { ...(pj?.data || {}) }; delete data.emi_data;
      promo = JSON.stringify(data).slice(0, 3500);
    }
    return { name: x.name.slice(0, 60), price: JSON.stringify(x.price?.effective || x.price), meta, aid, keys, pk, promo };
  }, q).catch(e => ({ e: e.message }));
  console.log('PROBE ' + JSON.stringify({ q, ...r }));
}
await browser.close();
