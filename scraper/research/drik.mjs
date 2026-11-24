// Drik Panchang monthly festival pages: plain fetch first, then a real browser; dump structure.
process.env.SCRAPER_TEST = '1';
const URLS = JSON.parse(process.env.SITES || '[]');
for (const u of URLS) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36', accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' } });
    const t = await r.text();
    console.log('PROBE ' + JSON.stringify({ u, how: 'fetch', status: r.status, len: t.length, title: (t.match(/<title>([^<]*)/) || [])[1] }));
    const i = t.indexOf('dpFestivalCard'); 
    console.log('PROBE ' + JSON.stringify({ sample: t.slice(Math.max(0, t.search(/Kartika Purnima|Ekadashi|Purnima/i) - 1500), t.search(/Kartika Purnima|Ekadashi|Purnima/i) + 1500) }));
  } catch (e) { console.log('PROBE ' + JSON.stringify({ u, err: e.message })); }
}
const { launch } = await import('../index.mjs');
const { browser, context } = await launch();
const page = await context.newPage();
await page.goto(URLS[0], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const txt = document.body.innerText;
  const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /Ekadashi/.test(e.textContent || ''));
  const chain = []; let p = el; for (let k = 0; p && k < 6; k++, p = p.parentElement) chain.push(p.tagName + '.' + (p.className || '').toString().slice(0, 60));
  const block = el?.closest('div[class*=card], div[class*=Card], li, tr')?.outerHTML?.slice(0, 1500);
  return { title: document.title, len: txt.length, text: txt.slice(0, 6000), chain, block };
});
console.log('PROBE ' + JSON.stringify(info));
await browser.close();
