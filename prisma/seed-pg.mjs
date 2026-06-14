import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const argon2 = require('argon2');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PROJECT  = 'xukbgkwagjtzxoobcyuk';
const PASSWORD = 'Harbans1073!';

const CONNECTIONS = [
  { host: 'aws-1-ap-northeast-1.pooler.supabase.com', port: 6543, user: `postgres.${PROJECT}`, password: PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false }, label: 'Transaction Pooler' },
  { host: 'aws-1-ap-northeast-1.pooler.supabase.com', port: 5432, user: `postgres.${PROJECT}`, password: PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false }, label: 'Session Pooler' },
  { host: `db.${PROJECT}.supabase.co`,            port: 5432, user: 'postgres',             password: PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false }, family: 4, label: 'Direct IPv4' },
];

async function connect() {
  for (const { label, ...cfg } of CONNECTIONS) {
    const c = new Client(cfg);
    try { await c.connect(); console.log(`Connected via ${label}`); return c; }
    catch (e) { console.log(`${label} failed: ${e.message.slice(0,80)}`); try{await c.end();}catch{} }
  }
  throw new Error('All connections failed');
}

async function main() {
  const email    = process.env.BOOTSTRAP_ADMIN_EMAIL    || 'harbans22@gmail.com';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Harbans@1073';

  const client = await connect();

  const perms = ['*','users.create','users.read','users.update','users.delete','users.restore',
    'roles.manage','products.create','products.read','products.update','products.delete',
    'categories.manage','warehouses.manage','warehouses.read','vendors.manage','vendors.read',
    'inventory.read','inventory.stock_in','inventory.stock_out','inventory.transfer',
    'inventory.adjust','inventory.reconcile','imei.read','imei.manage',
    'marketplace.read','marketplace.manage','reports.export','imports.run'];

  for (const code of perms)
    await client.query(`INSERT INTO permissions(id,code,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,$1,now(),now()) ON CONFLICT(code) DO NOTHING`, [code]);
  console.log('Permissions seeded.');

  await client.query(`INSERT INTO roles(id,name,description) VALUES(gen_random_uuid()::text,'ADMIN','Full access') ON CONFLICT(name) DO NOTHING`);
  await client.query(`INSERT INTO roles(id,name,description) VALUES(gen_random_uuid()::text,'STAFF','Read-only') ON CONFLICT(name) DO NOTHING`);
  await client.query(`INSERT INTO "_RolePermissions"("A","B") SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='ADMIN' AND p.code='*' ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO "_RolePermissions"("A","B") SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='STAFF' AND p.code IN('products.read','vendors.read','warehouses.read','inventory.read','imei.read','marketplace.read') ON CONFLICT DO NOTHING`);

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await client.query(`INSERT INTO users(id,email,"passwordHash","fullName","isActive") VALUES(gen_random_uuid()::text,$1,$2,'Administrator',true) ON CONFLICT DO NOTHING`, [email, hash]);
  await client.query(`INSERT INTO "_UserRoles"("A","B") SELECT u.id,r.id FROM users u,roles r WHERE u.email=$1 AND r.name='ADMIN' ON CONFLICT DO NOTHING`, [email]);

  console.log(`Admin seeded: ${email}`);
  await client.end();
}

main().catch(e => { console.error('Seed FATAL:', e.message); process.exit(1); });
