// Which parameters Amazon's a2iSMXSecondaryView needs.
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const URLS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const u of URLS) {
  const page = await context.newPage();
  const go = async () => { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(2500); };
  await go();
  const b = page.locator('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[type="submit"]').first();
  if (await b.count() && /continue shopping/i.test(await page.evaluate(() => document.body.innerText.slice(0, 500)))) { await b.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2000); await go(); }
  const out = await page.evaluate(async () => {
    const asin = location.pathname.match(/\/dp\/([A-Z0-9]{10})/)[1];
    const d = JSON.parse(document.querySelector('[data-action="side-sheet"][data-side-sheet]').getAttribute('data-side-sheet'));
    const html = document.documentElement.innerHTML;
    const ptn = (html.match(/productTypeName["=:\s]+"?([A-Z_]{3,})/) || [])[1];
    const pg = (html.match(/productGroupID["=:\s]+"?([a-z_]{3,})/) || [])[1];
    const base = `/gp/product/ajax/a2iSMXSecondaryView?deviceType=web&asin=${asin}&isVariationalMember=0&isVariationalParent=0&isB2BCustomer=false&buyingOptionIndex=0&encryptedMerchantId=${d.encryptedMerchantId}&showFeatures=sopp,inemi,promotions,vendorPoweredCoupon,sns&language=en_IN&isPrime=false&featureParams=viewName:bankOfferSecondaryView`;
    const variants = {
      plain: base,
      sr: base + `&requestId=${d.sr}`,
      fakeReq: base + `&requestId=F92A33BF105DD3SZTAFB`,
      types: base + `&productTypeName=${ptn || 'SPEAKERS'}&productGroupID=${pg || 'speakers_display_on_website'}`,
      typesSr: base + `&requestId=${d.sr}&productTypeName=${ptn || 'SPEAKERS'}&productGroupID=${pg || 'speakers_display_on_website'}`,
      speakers: base + `&productTypeName=SPEAKERS&productGroupID=speakers_display_on_website`,
    };
    const res = {};
    for (const [k, v] of Object.entries(variants)) {
      try { const r = await fetch(v, { credentials: 'include' }); const t = await r.text(); res[k] = `${r.status} len=${t.length} inr=${(t.match(/Instant Discount/g) || []).length}`; } catch (e) { res[k] = 'ERR ' + e.message; }
    }
    return { ptn, pg, res };
  });
  console.log('PROBE ' + JSON.stringify({ u, ...out }));
  await page.close();
}
await browser.close();
