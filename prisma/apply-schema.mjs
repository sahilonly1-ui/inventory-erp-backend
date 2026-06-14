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
  // Primary: Supabase Session Pooler (always IPv4, works from Render Oregon)
  const POOLER_URL = 'postgresql://postgres.xukbgkwagjtzxoobcyuk:Harbans_1073@aws-0-us-west-1.pooler.supabase.com:5432/postgres';
  const rawUrl = process.env.DATABASE_URL || POOLER_URL;

  console.log('Connecting to database...');
  try {
    const parsed = new URL(rawUrl.includes('://') ? rawUrl : 'postgresql://' + rawUrl);
    console.log('Host:', parsed.hostname);
  } catch(e) { console.log('URL:', rawUrl.slice(0, 40) + '...'); }

  const configs = [
    // Try pooler first (IPv4, no SSL issues)
    { connectionString: POOLER_URL, ssl: { rejectUnauthorized: false } },
    // Then try env var
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
