// Amazon card layout: where the full bank-offer list lives (hidden DOM or a request on click).
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const URLS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const u of URLS) {
  const page = await context.newPage();
  const reqs = [];
  page.on('request', r => { const x = r.url(); if (!/\.(js|css|png|jpe?g|gif|svg|woff2?|webp)(\?|$)/i.test(x) && /amazon\.in/.test(x) && !/unagi|uedata|fls-eu|csm/.test(x)) reqs.push(r.method() + ' ' + x.slice(0, 400)); });
  const go = async () => { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(2500); };
  await go();
  const b = page.locator('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[type="submit"]').first();
  if (await b.count() && /continue shopping/i.test(await page.evaluate(() => document.body.innerText.slice(0, 500)))) { await b.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2000); await go(); }
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(600); }
  const hidden = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const hits = [...html.matchAll(/.{0,200}(vsx|sideSheet|side-sheet|InstantBankDiscount)[^"'<]{0,200}/gi)].map(m => m[0].replace(/\s+/g, ' ')).filter(t => /ajax|url|\/gp\/|https?:|endpoint/i.test(t)).slice(0, 15);
    const sheets = [...document.querySelectorAll('[id*=sheet i],[class*=sheet i]')].map(e => `${e.tagName}#${e.id}.${String(e.className).slice(0, 60)} len=${(e.textContent || '').length}`).slice(0, 15);
    const triggers = [...document.querySelectorAll('[data-action="side-sheet"]')].map(e => ({ attrs: [...e.attributes].map(a => `${a.name}=${a.value.slice(0, 200)}`).join(' | '), inner: e.innerHTML.slice(0, 600) })).slice(0, 2);
    return { hits, sheets, triggers };
  });
  console.log('PROBE ' + JSON.stringify({ u, ...hidden }));
  const before = reqs.length;
  const card = page.locator('[data-action="side-sheet"]').filter({ hasText: /Bank Offer/ }).first();
  if (await card.count()) {
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const box = await card.boundingBox().catch(() => null);
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + Math.min(15, box.height / 2));
    else await card.click({ timeout: 5000, force: true }).catch(e => console.log('click', e.message));
    await page.waitForTimeout(5000);
    const after = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('.vsx__offer-sideSheet-ajax-block, .vsx__offers-sideSheet-fallback, [class*=sideSheet], [id*=sideSheet], [class*=side-sheet]')].map(e => `${e.tagName}.${String(e.className).slice(0, 70)} vis=${e.offsetHeight} :: ${(e.innerText || '').slice(0, 1500)}`);
      return blocks.slice(0, 8);
    });
    console.log('PROBE ' + JSON.stringify({ u, reqs: reqs.slice(before, before + 20), after }));
  }
  await page.close();
}
await browser.close();
