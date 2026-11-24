// Can a server read Bing / DuckDuckGo results?
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36';
for (const q of JSON.parse(process.env.SITES || '[]')) {
  for (const [name, u] of [['bing', `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-IN&cc=IN`], ['ddg', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`], ['ddglite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`], ['brave', `https://search.brave.com/search?q=${encodeURIComponent(q)}`], ['startpage', `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}`], ['yahoo', `https://in.search.yahoo.com/search?p=${encodeURIComponent(q)}`], ['mojeek', `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`]]) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' } });
      const t = await r.text();
      const links = [...t.matchAll(/href="(https?:\/\/(?:www\.)?(gadgets360|91mobiles|smartprix|gsmarena|flipkart|amazon)[^"]{5,200})"/g)].map(m => m[1]).slice(0, 4);
      const ddg = [...t.matchAll(/uddg=([^&"]+)/g)].map(m => decodeURIComponent(m[1])).filter(x => /gadgets360|91mobiles|smartprix|gsmarena/.test(x)).slice(0, 3);
      const yh = [...t.matchAll(/RU=([^/"]+)\//g)].map(m => decodeURIComponent(m[1])).filter(x => /gadgets360|91mobiles|smartprix|gsmarena/.test(x)).slice(0, 3);
      console.log('PROBE ' + JSON.stringify({ q, name, status: r.status, len: t.length, b_algo: (t.match(/b_algo/g) || []).length, links, ddg, yh, head: t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 150) }));
    } catch (e) { console.log('PROBE ' + JSON.stringify({ q, name, err: e.message })); }
  }
}
