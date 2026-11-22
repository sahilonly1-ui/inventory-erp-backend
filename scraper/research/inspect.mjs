// Open a page and run a snippet of JS in it (SITES = [{url, js, wait, pre}]); prints what the snippet returns.
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const LIST = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const it of LIST) {
  const page = await context.newPage();
  if (it.pre) await page.addInitScript(it.pre);
  await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
  await page.waitForTimeout(it.wait || 9000);
  const out = await page.evaluate(`(async () => { ${it.js} })()`).catch(e => 'ERR ' + e.message);
  console.log('PROBE ' + JSON.stringify({ url: it.url, final: page.url(), out }));
  await page.close();
}
await browser.close();
