// Amazon: full popup URL from the "Save Extra" layout, then the same endpoint for a card-layout product.
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const [A, B] = JSON.parse(process.env.SITES || '[]');   // A = Save Extra layout, B = card layout
const { browser, context } = await launch();
const openP = async u => {
  const page = await context.newPage();
  const go = async () => { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(2500); };
  await go();
  const b = page.locator('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[type="submit"]').first();
  if (await b.count() && /continue shopping/i.test(await page.evaluate(() => document.body.innerText.slice(0, 500)))) { await b.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2000); await go(); }
  return page;
};
const pa = await openP(A);
const urls = await pa.evaluate(() => [...document.querySelectorAll('[data-a-modal]')].map(e => { try { return JSON.parse(e.getAttribute('data-a-modal')).url; } catch { return null; } }).filter(u => u && /SecondaryView/.test(u)));
console.log('PROBE ' + JSON.stringify({ A, urls }));
const pb = await openP(B);
const info = await pb.evaluate(() => {
  const t = [...document.querySelectorAll('[data-action="side-sheet"]')].map(e => { try { return JSON.parse(e.getAttribute('data-side-sheet')); } catch { return null; } }).filter(Boolean);
  const html = document.documentElement.innerHTML;
  const ptn = (html.match(/"productTypeName"\s*:\s*"([^"]+)"/) || [])[1] || (html.match(/productTypeName=([A-Z_]+)/) || [])[1];
  const pg = (html.match(/productGroupID=([a-z_]+)/) || [])[1];
  return { t, ptn, pg };
});
console.log('PROBE ' + JSON.stringify({ B, info }));
const asinB = B.match(/dp\/([A-Z0-9]{10})/)[1];
const results = [];
for (const raw of urls.slice(0, 3)) {
  for (const s of info.t.filter(x => /Bank|Cashback/i.test(x.contentId))) {
    const u = new URL(raw, 'https://www.amazon.in');
    u.searchParams.set('asin', asinB);
    if (s.encryptedMerchantId) u.searchParams.set('encryptedMerchantId', s.encryptedMerchantId);
    u.searchParams.delete('variationalParentASIN'); u.searchParams.set('isVariationalMember', '0');
    const txt = await pb.evaluate(async x => { try { const r = await fetch(x, { credentials: 'include' }); const h = await r.text(); const d = new DOMParser().parseFromString(h, 'text/html'); d.querySelectorAll('script,style').forEach(n => n.remove()); return r.status + ' ' + (d.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500); } catch (e) { return 'ERR ' + e.message; } }, u.toString());
    results.push({ content: s.contentId, url: u.toString().slice(0, 500), txt });
  }
}
console.log('PROBE ' + JSON.stringify(results));
await browser.close();
