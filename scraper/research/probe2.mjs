// Research probe 2: fetch given URLs and show what they hold (sitemaps → product URLs, JSON → keys).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const LIST = JSON.parse(process.env.SITES || '[]');
const get = async url => {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: ctl.signal });
    clearTimeout(t);
    return { status: r.status, url: r.url, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e.message || e).slice(0, 80), body: '' }; }
};
for (const it of LIST) {
  const r = await get(it.url);
  const out = { url: it.url, status: r.status, final: r.url, len: r.body.length, err: r.err };
  const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  if (locs.length) {
    out.locs = locs.length;
    out.xmls = locs.filter(l => /\.xml/i.test(l)).slice(0, 15);
    const re = it.grep ? new RegExp(it.grep, 'i') : null;
    out.match = (re ? locs.filter(l => re.test(l)) : locs.filter(l => !/\.xml/i.test(l))).slice(0, it.n || 12);
    out.matchN = re ? locs.filter(l => re.test(l)).length : null;
  } else if (/^\s*[\[{]/.test(r.body)) {
    try {
      const j = JSON.parse(r.body);
      out.json = JSON.stringify(j, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) : v)).slice(0, it.n || 2500);
    } catch { out.text = r.body.slice(0, 600); }
  } else {
    const re = it.grep ? new RegExp(it.grep, 'gi') : null;
    out.text = re ? [...new Set(r.body.match(re) || [])].slice(0, it.n || 20) : r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
  }
  console.log('PROBE ' + JSON.stringify(out));
}
