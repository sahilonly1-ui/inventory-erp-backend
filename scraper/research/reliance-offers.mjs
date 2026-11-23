// Where Reliance Digital's bank offers come from: every JSON answer that talks about
// offers / banks while a product page loads, plus the page text around "Offers".
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const QS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
const home = await context.newPage();
await home.goto('https://www.reliancedigital.in/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
await home.waitForTimeout(4000);
for (const q of QS) {
  const slug = await home.evaluate(async q => {
    const res = await fetch(`/ext/raven-api/catalog/v1.0/products?q=${encodeURIComponent(q)}&page_id=*&page_no=1&page_size=5&page_type=number`, { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => ({}));
    return (j.items || [])[0]?.slug;
  }, q).catch(() => null);
  if (!slug) { console.log('PROBE ' + JSON.stringify({ q, slug: null })); continue; }
  const page = await context.newPage();
  const hits = [];
  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (/\.(js|css|png|jpe?g|webp|svg|woff2?|gif)(\?|$)/i.test(u)) return;
      const t = await resp.text();
      if (!/(offer|bank|promotion|coupon|cashback)/i.test(t) || t.length < 50) return;
      if (!/^\s*[\[{]/.test(t)) return;
      hits.push({ u: u.slice(0, 220), m: resp.request().method(), body: (resp.request().postData() || '').slice(0, 400), len: t.length,
        snip: (t.match(/.{0,200}(bank|cashback|instant discount).{0,400}/i) || [''])[0].slice(0, 700) });
    } catch { }
  });
  await page.goto(`https://www.reliancedigital.in/product/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
  await page.waitForTimeout(6000);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(800); }
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const i = text.search(/offers?/i);
  const offerText = [...text.matchAll(/.{0,80}(bank|cashback|instant discount|offer).{0,160}/gi)].map(m => m[0]).slice(0, 25);
  // Buttons / links that open an offers sheet
  const btns = await page.evaluate(() => [...document.querySelectorAll('button,a,[role=button],div[class*=offer i],span[class*=offer i]')]
    .map(e => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter(t => /offer|bank/i.test(t) && t.length < 80).slice(0, 15)).catch(() => []);
  console.log('PROBE ' + JSON.stringify({ q, slug, offerText, btns }));
  for (const h of hits) console.log('PROBE ' + JSON.stringify({ q, hit: h }));
  // Try opening "View all offers"-type control and read again
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button,a,[role=button],div,span')].find(e => /^(view (all|more) offers?|all offers|bank offers?|\+\s?\d+ more|more offers)$/i.test((e.innerText || '').trim()));
    if (el) { el.click(); return el.innerText.trim(); } return null;
  }).catch(() => null);
  if (clicked) {
    await page.waitForTimeout(3000);
    const t2 = await page.evaluate(() => document.body.innerText).catch(() => '');
    console.log('PROBE ' + JSON.stringify({ q, clicked, after: [...t2.matchAll(/.{0,80}(bank|cashback|instant discount).{0,200}/gi)].map(m => m[0]).slice(0, 20) }));
  }
  await page.close();
}
await browser.close();
