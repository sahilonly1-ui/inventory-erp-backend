// Render pages in Chrome and show where prices live: visible ₹ texts, JSON responses with prices, links.
process.env.SCRAPER_TEST = '1';
const { launch } = await import('../index.mjs');
const LIST = JSON.parse(process.env.SITES || '[]');
const { browser, context } = await launch();
for (const it of LIST) {
  const page = await context.newPage();
  const nets = [];
  page.on('response', async r => {
    try {
      const ct = r.headers()['content-type'] || '';
      if (!/json/.test(ct)) return;
      const t = await r.text();
      if (!new RegExp((it.net || 'price|Price|sellingPrice|salePrice').replace('(?i)', ''), 'i').test(t)) return;
      nets.push({ u: r.url().slice(0, 160), n: t.length, s: (t.match(/"[a-zA-Z_]*(price|Price|amount)[a-zA-Z_]*"\s*:\s*"?[\d.]+/g) || []).slice(0, 6), head: it.net ? t.slice(0, it.headLen || 700) : undefined, post: it.net ? (r.request().postData() || '').slice(0, 600) : undefined });
    } catch {}
  });
  let err = '';
  try { await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { err = e.message.slice(0, 80); }
  await page.waitForTimeout(it.wait || 9000);
  const info = await page.evaluate(g => {
    const rs = [...document.querySelectorAll('body *')].filter(e => e.children.length <= 1 && /₹\s?[\d,]{3,}/.test(e.textContent || '') && (e.textContent || '').length < 60)
      .map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 12);
    const links = g ? [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => new RegExp(g, 'i').test(h)))].slice(0, 20) : [];
    const btn = [...document.querySelectorAll('button,a')].filter(b => /buy|cart|notify|sold out|out of stock/i.test((b.innerText || '').trim()) && (b.innerText || '').trim().length < 30).map(b => (b.innerText || '').trim() + ' -> ' + (b.href || b.closest('a')?.href || '')).slice(0, 8);
    const opts = [...document.querySelectorAll('button,label,li,span,div,a')].filter(e => { const t = (e.innerText || '').trim(); return t && t.length < 30 && /\d\s*(gb|tb)/i.test(t) && ![...e.children].some(c => (c.innerText || '').trim() === t); }).map(e => e.tagName + ':' + (e.innerText || '').trim().replace(/\s+/g, ' ') + (e.className ? ' .' + String(e.className).slice(0, 40) : '')).slice(0, 14);
    return { title: document.title.slice(0, 80), rs, links, btn, opts, ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent.slice(0, 300)).filter(t => /price/i.test(t)).slice(0, 2) };
  }, it.grep || '').catch(e => ({ e: e.message }));
  console.log('PROBE ' + JSON.stringify({ url: it.url, final: page.url(), err, ...info, nets: nets.slice(0, 8) }));
  await page.close();
}
await browser.close();
