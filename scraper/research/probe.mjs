// Research probe (run on GitHub Actions): how can each brand site be searched without a person?
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const SITES = JSON.parse(process.env.SITES || '[]');
const get = async (url, accept = 'text/html,application/json,*/*') => {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: ctl.signal });
    clearTimeout(t);
    const body = await r.text();
    return { status: r.status, url: r.url, ct: r.headers.get('content-type') || '', len: body.length, body, h: Object.fromEntries([...r.headers].filter(([k]) => /server|powered|shop|vtex|x-cache|cf-ray|akamai/i.test(k))) };
  } catch (e) { return { status: 0, err: String(e.message || e).slice(0, 80), body: '' }; }
};
for (const s of SITES) {
  const base = `https://${s.host}`;
  const out = { site: s.host, q: s.q };
  const home = await get(base + (s.path || '/'));
  out.home = { status: home.status, url: home.url, len: home.len, h: home.h, platform:
    /cdn\.shopify|Shopify\.theme/i.test(home.body) ? 'shopify' : /vtex/i.test(home.body) ? 'vtex' : /demandware|dwvar|sfcc/i.test(home.body) ? 'sfcc'
    : /magento|mage-/i.test(home.body) ? 'magento' : /__NEXT_DATA__/.test(home.body) ? 'next' : /fynd/i.test(home.body) ? 'fynd' : '?' };
  const robots = await get(base + '/robots.txt', 'text/plain');
  out.sitemaps = [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]).slice(0, 8);
  const sp = await get(`${base}/search/suggest.json?q=${encodeURIComponent(s.q)}&resources[type]=product&resources[limit]=6`, 'application/json');
  try { const j = JSON.parse(sp.body); out.shopify = (j.resources?.results?.products || []).map(p => `${p.title} | ${p.url} | ${p.price}`).slice(0, 6); } catch { out.shopify = sp.status; }
  const vt = await get(`${base}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(s.q)}&_from=0&_to=5`, 'application/json');
  try { const j = JSON.parse(vt.body); out.vtex = Array.isArray(j) ? j.map(p => `${p.productName} | ${p.link} | ${p.items?.length} skus`).slice(0, 6) : vt.status; } catch { out.vtex = vt.status; }
  // First product-ish sitemap: count and sample
  for (const sm of out.sitemaps.slice(0, 3)) {
    const x = await get(sm, 'application/xml');
    const locs = [...x.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
    (out.sm ||= []).push({ sm, status: x.status, n: locs.length, sample: locs.filter(l => !/\.(jpg|png|webp)/i.test(l)).slice(0, 4) });
  }
  if (s.search) {
    const se = await get(s.search.replace('{q}', encodeURIComponent(s.q)));
    const links = [...se.body.matchAll(/href="([^"#]+)"/g)].map(m => m[1]).filter(h => /\d|product|\/p\//i.test(h)).slice(0, 12);
    out.search = { status: se.status, len: se.len, links };
  }
  console.log('PROBE ' + JSON.stringify(out));
}
