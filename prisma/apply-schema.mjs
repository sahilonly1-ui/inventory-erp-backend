import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL not set');
  
  console.log('Connecting to database...');
  console.log('Host:', new URL(rawUrl).hostname);
  
  // Try multiple SSL configs
  const configs = [
    { connectionString: rawUrl, ssl: { rejectUnauthorized: false } },
    { connectionString: rawUrl + '?sslmode=require', ssl: { rejectUnauthorized: false } },
    { connectionString: rawUrl, ssl: false },
  ];
  
  let client = null;
  for (const cfg of configs) {
    try {
      client = new Client(cfg);
      await client.connect();
      console.log('Connected!');
      break;
    } catch (e) {
      console.log('Config failed:', e.message.slice(0, 100));
      try { await client.end(); } catch {}
      client = null;
    }
  }
  
  if (!client) throw new Error('Could not connect to database with any SSL configuration');

  console.log('Applying schema...');
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  
  // Split and run statements individually for better error reporting
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  console.log(`Running ${statements.length} SQL statements...`);
  let ok = 0, skipped = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt);
      ok++;
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('duplicate')) {
        skipped++;
      } else {
        console.error('SQL error:', e.message.slice(0, 200));
        console.error('Statement:', stmt.slice(0, 100));
      }
    }
  }
  
  console.log(`Done: ${ok} applied, ${skipped} already existed.`);
  await client.end();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
