// Calls an ERP API URL and prints a short summary.
for (const u of JSON.parse(process.env.SITES || '[]')) {
  const r = await fetch(u, { headers: { origin: 'https://inventoryhss.netlify.app' } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { }
  console.log('PROBE ' + JSON.stringify({ u, status: r.status, cors: r.headers.get('access-control-allow-origin'), n: Array.isArray(j?.data) ? j.data.length : null, head: Array.isArray(j?.data) ? j.data.filter(e => e.day >= '2026-11-24').slice(0, 12) : t.slice(0, 300) }));
}
