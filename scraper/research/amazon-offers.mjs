// Amazon offer cards layout: what opens the full bank-offer list.
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const URLS = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const u of URLS) {
  const page = await context.newPage();
  const reqs = [];
  page.on('request', r => { const x = r.url(); if (/offer|vsx|sopp|itembox|bankOffer|ajax|secondary/i.test(x) && !/\.(js|css|png|jpg|gif|svg|woff)/.test(x)) reqs.push(r.method() + ' ' + x.slice(0, 300)); });
  await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
  await page.waitForTimeout(3000);
  for (let k = 0; k < 2; k++) {
    const b = page.locator('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[type="submit"]').first();
    if (await b.count()) { await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), b.click({ timeout: 5000 }).catch(() => {})]); await page.waitForTimeout(2000); await page.goto(u, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(3000); }
  }
  await page.waitForTimeout(3000);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(700); }
  console.log('PROBE ' + JSON.stringify({ u, title: await page.title(), body: (await page.evaluate(() => document.body.innerText)).slice(0, 600) }));
  const info = await page.evaluate(() => {
    const modals = [...document.querySelectorAll('[data-a-modal],[data-a-popover],[data-action]')].map(e => ({ tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 80), modal: (e.getAttribute('data-a-modal') || e.getAttribute('data-a-popover') || e.getAttribute('data-action') || '').slice(0, 400), text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) })).filter(m => /offer|bank|cashback|vsx|emi/i.test(m.modal + m.text + m.id + m.cls)).slice(0, 25);
    const cards = [...document.querySelectorAll('[id*=offer i],[class*=offer i]')].map(e => `${e.tagName}#${e.id}.${String(e.className).slice(0, 60)} :: ${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)}`).slice(0, 30);
    return { modals, cards };
  });
  console.log('PROBE ' + JSON.stringify({ u, ...info }));
  // Click the "Bank Offer" card
  const before = reqs.length;
  const card = page.getByText(/^Bank Offer$/).filter({ visible: true }).first();
  if (await card.count()) {
    await card.click({ timeout: 5000 }).catch(e => console.log('click', e.message));
    await page.waitForTimeout(4000);
    const sheet = await page.evaluate(() => {
      const vis = [...document.querySelectorAll('.a-popover, #vsxoffers_feature_div, [id*=side-sheet], [class*=side-sheet], .a-sheet-web, [role=dialog]')].filter(e => e.offsetHeight > 0);
      return vis.map(e => `${e.tagName}#${e.id}.${String(e.className).slice(0, 60)} :: ${(e.innerText || '').slice(0, 2500)}`).slice(0, 3);
    });
    console.log('PROBE ' + JSON.stringify({ u, clicked: true, newReqs: reqs.slice(before, before + 15), sheet }));
  } else console.log('PROBE ' + JSON.stringify({ u, clicked: false, text: (await page.evaluate(() => document.body.innerText)).match(/.{0,200}Bank Offer.{0,300}/s)?.[0] }));
  await page.close();
}
await browser.close();
