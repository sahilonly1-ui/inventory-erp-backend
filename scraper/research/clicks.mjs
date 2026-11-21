// Click variant options on a page and show price texts after each click.
process.env.SCRAPER_TEST = '1';
const { launch, readPage, pickMemoryVariant } = await import('../index.mjs');
const LIST = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const it of LIST) {
  const page = await context.newPage();
  await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(8000);
  if (it.pick) { const v = await pickMemoryVariant(page, { name: it.pick, variant: null }).catch(e => 'ERR ' + e.message); console.log('PICK', it.pick, v); }
  for (const label of [null, ...(it.clicks || [])]) {
    if (label) {
      const n = await page.evaluate(l => { const e = [...document.querySelectorAll('div,span,label,button,li')].filter(x => (x.innerText || '').trim() === l).pop(); if (!e) return 'missing'; e.click(); return e.tagName + '.' + e.className; }, label);
      await page.waitForTimeout(3000);
      console.log('CLICK', label, n);
    }
    const r = await page.evaluate(readPage, 'official').catch(e => ({ e: e.message }));
    const rs = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.children.length <= 1 && /₹\s?[\d,]{3,}/.test(e.textContent || '') && (e.textContent || '').length < 40).map(e => { const cs = getComputedStyle(e); return (e.textContent || '').trim() + '@' + cs.fontSize + (/line-through/.test(cs.textDecorationLine) ? '-struck' : '') + '@' + Math.round(e.getBoundingClientRect().top); }).slice(0, 14));
    console.log('PROBE ' + JSON.stringify({ url: it.url, after: label, price: r.price, priceText: r.priceText, ld: r.ldPrice, rs }));
  }
  await page.close();
}
await browser.close();
