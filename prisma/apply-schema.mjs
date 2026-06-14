// apply-schema.mjs — applies schema.sql to Supabase via pg (no Prisma engine needed)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to database.');

  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
  console.log('Schema applied.');

  await client.end();
}

main().catch(e => { console.error('Schema apply failed:', e.message); process.exit(1); });
