import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');
const dns = require('dns');

// Force IPv4 — Render Oregon can't reach Supabase over IPv6
dns.setDefaultResultOrder('ipv4first');

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL not set');

  // Parse and force IPv4 by using the pooler port (6543) or adding sslmode
  // Supabase pooler: aws-0-us-west-1.pooler.supabase.com:6543
  // Direct with IPv4 forced via dns.setDefaultResultOrder above
  console.log('Connecting to database...');
  console.log('Host:', new URL(rawUrl.replace('?', '/?')).hostname);

  const configs = [
    // Try direct connection with IPv4 forced
    { connectionString: rawUrl, ssl: { rejectUnauthorized: false }, family: 4 },
    { connectionString: rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'sslmode=require', ssl: { rejectUnauthorized: false }, family: 4 },
  ];

  let client = null;
  let lastError = '';

  for (const cfg of configs) {
    try {
      client = new Client(cfg);
      await client.connect();
      console.log('Connected!');
      break;
    } catch (e) {
      lastError = e.message;
      console.log('Config failed:', e.message.slice(0, 120));
      try { await client.end(); } catch {}
      client = null;
    }
  }

  if (!client) {
    throw new Error('Could not connect to database: ' + lastError);
  }

  console.log('Applying schema...');
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 5 && !s.startsWith('--'));

  let ok = 0, skipped = 0, errors = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt);
      ok++;
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('duplicate')) {
        skipped++;
      } else {
        console.error('SQL error:', e.message.slice(0, 150));
        errors++;
      }
    }
  }

  console.log(`Schema done: ${ok} applied, ${skipped} already existed, ${errors} errors.`);
  await client.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
