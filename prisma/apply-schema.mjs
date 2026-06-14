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
const PASSWORD = 'Harbans_1073';

const CONNECTIONS = [
  // Transaction pooler (IPv4, port 6543) — project ref in username triggers SNI
  {
    host: 'aws-0-us-west-1.pooler.supabase.com',
    port: 6543,
    user: `postgres.${PROJECT}`,
    password: PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    label: 'Transaction Pooler 6543'
  },
  // Session pooler (IPv4, port 5432)
  {
    host: 'aws-0-us-west-1.pooler.supabase.com',
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
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 5 && !s.startsWith('--'));

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
