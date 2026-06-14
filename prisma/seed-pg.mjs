// seed-pg.mjs — seeds DB via pg + argon2 (no Prisma client needed)
import { createRequire } from 'module';
import dns from 'dns';
// Force IPv4 — Render Oregon cannot reach Supabase over IPv6
dns.setDefaultResultOrder('ipv4first');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const argon2 = require('argon2');

async function main() {
  const url = process.env.DATABASE_URL;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'harbans22@gmail.com';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Harbans@1073';

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected. Seeding...');

  // Permissions
  const perms = [
    '*','users.create','users.read','users.update','users.delete','users.restore','roles.manage',
    'products.create','products.read','products.update','products.delete','categories.manage',
    'warehouses.manage','warehouses.read','vendors.manage','vendors.read',
    'inventory.read','inventory.stock_in','inventory.stock_out','inventory.transfer',
    'inventory.adjust','inventory.reconcile','imei.read','imei.manage',
    'marketplace.read','marketplace.manage','reports.export','imports.run'
  ];

  for (const code of perms) {
    await client.query(
      `INSERT INTO permissions(id,code) VALUES(gen_random_uuid()::text,$1) ON CONFLICT(code) DO NOTHING`,
      [code]
    );
  }
  console.log('Permissions seeded.');

  // Roles
  await client.query(`INSERT INTO roles(id,name,description) VALUES(gen_random_uuid()::text,'ADMIN','Full access') ON CONFLICT(name) DO NOTHING`);
  await client.query(`INSERT INTO roles(id,name,description) VALUES(gen_random_uuid()::text,'STAFF','Read-only staff') ON CONFLICT(name) DO NOTHING`);

  // ADMIN -> wildcard
  await client.query(`
    INSERT INTO "_RolePermissions"("A","B")
    SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='ADMIN' AND p.code='*'
    ON CONFLICT DO NOTHING`);

  // STAFF -> read perms
  await client.query(`
    INSERT INTO "_RolePermissions"("A","B")
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name='STAFF' AND p.code IN ('products.read','vendors.read','warehouses.read','inventory.read','imei.read','marketplace.read')
    ON CONFLICT DO NOTHING`);

  // Admin user
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await client.query(`
    INSERT INTO users(id,email,"passwordHash","fullName","isActive")
    VALUES(gen_random_uuid()::text,$1,$2,'Administrator',true)
    ON CONFLICT DO NOTHING`, [email, hash]);

  // Link to ADMIN role
  await client.query(`
    INSERT INTO "_UserRoles"("A","B")
    SELECT u.id, r.id FROM users u, roles r WHERE u.email=$1 AND r.name='ADMIN'
    ON CONFLICT DO NOTHING`, [email]);

  console.log(`Admin user seeded: ${email}`);
  await client.end();
}

main().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
