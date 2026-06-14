import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');

// Disable SSL cert verification for Supabase pooler
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supabase Transaction Pooler (port 6543) — IPv4, works from Render
// Username: postgres (NOT postgres.projectref)
const POOLER = 'postgresql://postgres:Harbans_1073@aws-0-us-west-1.pooler.supabase.com:6543/postgres';
// Direct connection as fallback
const DIRECT = 'postgresql://postgres:Harbans_1073@db.xukbgkwagjtzxoobcyuk.supabase.co:5432/postgres';

async function tryConnect(url, label) {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    console.log(`Connected via ${label}!`);
    return client;
  } catch (e) {
    console.log(`${label} failed: ${e.message.slice(0, 100)}`);
    try { await client.end(); } catch {}
    return null;
  }
}

async function main() {
  console.log('Connecting to Supabase...');

  let client = await tryConnect(POOLER, 'Transaction Pooler');
  if (!client) client = await tryConnect(DIRECT, 'Direct Connection');
  if (!client) throw new Error('All connection attempts failed');

  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 5 && !s.startsWith('--'));

  console.log(`Running ${statements.length} SQL statements...`);
  let ok = 0, skip = 0, err = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt);
      ok++;
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('duplicate')) skip++;
      else { console.error('SQL:', e.message.slice(0, 100), '|', stmt.slice(0, 60)); err++; }
    }
  }

  console.log(`Schema done: ${ok} ok, ${skip} skipped, ${err} errors`);
  await client.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
