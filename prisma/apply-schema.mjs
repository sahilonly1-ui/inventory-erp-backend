import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supabase connection options — all with project ref in username for SNI
const PROJECT = 'xukbgkwagjtzxoobcyuk';
const PASSWORD = process.env.DB_PASSWORD || 'Harbans_1073'; // Render sets this correctly

// Parse DATABASE_URL if available (Render sets this correctly)
const DB_URL = process.env.DATABASE_URL;
const parsedUrl = DB_URL ? (() => {
  try {
    const u = new URL(DB_URL);
    return { host: u.hostname, port: parseInt(u.port||'5432'), user: u.username, password: u.password, database: u.pathname.slice(1), ssl: { rejectUnauthorized: false }, label: 'DATABASE_URL env var' };
  } catch { return null; }
})() : null;

const CONNECTIONS = [
  // PRIMARY: use DATABASE_URL from Render environment (correct credentials!)
  ...(parsedUrl ? [parsedUrl] : []),
  // Transaction pooler (IPv4, port 6543) — project ref in username triggers SNI
  {
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 6543,
    user: `postgres.${PROJECT}`,
    password: PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    label: 'Transaction Pooler 6543'
  },
  // Session pooler (IPv4, port 5432)
  {
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${PROJECT}`,
    password: PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    label: 'Session Pooler 5432'
  },
  // Direct via IPv4 forced (fallback)
  {
    host: `db.${PROJECT}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password: PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    family: 4,
    label: 'Direct IPv4'
  },
];

async function main() {
  console.log('Connecting to Supabase...');

  let client = null;
  for (const { label, ...cfg } of CONNECTIONS) {
    const c = new Client(cfg);
    try {
      await c.connect();
      console.log(`Connected via ${label}!`);
      client = c;
      break;
    } catch (e) {
      console.log(`${label} failed: ${e.message.slice(0, 100)}`);
      try { await c.end(); } catch {}
    }
  }

  if (!client) throw new Error('All connection attempts failed');

  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(';')
    .map(s => s.replace(/^(\s*--[^\n]*\n)+/gm, '').trim())
    .filter(s => {
      if (s.length <= 5 || s.startsWith('--')) return false;
      // Never run a DROP from this file. It executes on every deploy, and a
      // single DROP of a junction table takes every role assignment and granted
      // permission with it. schema.sql no longer contains any, but this runs
      // unattended against production — the guard stays.
      if (s.trimStart().toUpperCase().startsWith('DROP ')) {
        console.log('[schema] Skipped DROP statement (destructive):', s.slice(0, 60));
        return false;
      }
      return true;
    });

  console.log(`Applying ${statements.length} statements...`);
  let ok = 0, skip = 0, err = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt);
      ok++;
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('duplicate')) skip++;
      else { console.error('ERR:', e.message.slice(0, 120)); err++; }
    }
  }

  console.log(`Schema: ${ok} applied, ${skip} skipped, ${err} errors`);
  await client.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
