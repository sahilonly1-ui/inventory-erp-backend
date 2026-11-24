// amazonSoppOffers on a card-layout page, with what it saw.
process.env.SCRAPER_TEST = '1';
const { launch, amazonSoppOffers } = await import('../index.mjs');
const URLS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const u of URLS) {
  const page = await context.newPage();
  const go = async () => { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(2500); };
  await go();
  const b = page.locator('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[type="submit"]').first();
  if (await b.count() && /continue shopping/i.test(await page.evaluate(() => document.body.innerText.slice(0, 500)))) { await b.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2000); await go(); }
  const seen = await page.evaluate(() => ({ path: location.pathname, triggers: document.querySelectorAll('[data-action="side-sheet"][data-side-sheet]').length, asinInput: document.querySelector('input#ASIN, input[name="ASIN"]')?.value }));
  const r = await amazonSoppOffers(page, 37989);
  console.log('PROBE ' + JSON.stringify({ u, seen, popups: r.popupCount, lines: r.lineCount, offers: r.offers.map(o => `${o.bank}|${o.offerType}|${o.mode}|${o.amount}|${o.percent}|${o.maxDiscount}|${o.minTxn}`) }));
  await page.close();
}
await browser.close();
