import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const argon2 = require('argon2');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PROJECT  = 'xukbgkwagjtzxoobcyuk';
const PASSWORD = 'Harbans1073!';

const CONNECTIONS = [
  { host: 'aws-1-ap-northeast-1.pooler.supabase.com', port: 5432, user: `postgres.${PROJECT}`, password: PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false }, label: 'Session Pooler 5432' },
  { host: 'aws-1-ap-northeast-1.pooler.supabase.com', port: 6543, user: `postgres.${PROJECT}`, password: PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false }, label: 'Transaction Pooler 6543' },
];

async function connect() {
  for (const { label, ...cfg } of CONNECTIONS) {
    const c = new Client(cfg);
    try { await c.connect(); console.log(`[seed] Connected via ${label}`); return c; }
    catch (e) { console.log(`[seed] ${label} failed: ${e.message?.slice(0,80)}`); try{await c.end();}catch{} }
  }
  throw new Error('All connections failed');
}

async function main() {
  const email    = process.env.BOOTSTRAP_ADMIN_EMAIL    || 'harbans22@gmail.com';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Harbans@1073';

  const client = await connect();

  // Check if already seeded correctly — skip if admin has wildcard permission
  const check = await client.query(`
    SELECT COUNT(*) as cnt FROM users u
    JOIN "_UserRoles" ur ON ur."A"=u.id
    JOIN roles r ON r.id=ur."B"
    JOIN "_RolePermissions" rp ON rp."A"=r.id
    JOIN permissions p ON p.id=rp."B"
    WHERE u.email=$1 AND p.code='*'`, [email]);

  if (parseInt(check.rows[0]?.cnt) > 0) {
    console.log('[seed] Already seeded correctly — skipping.');
    await client.end();
    return;
  }

  console.log('[seed] Seeding from scratch...');

  // Permissions
  const perms = ['*','users.create','users.read','users.update','users.delete','users.restore',
    'roles.manage','products.create','products.read','products.update','products.delete',
    'categories.manage','warehouses.manage','warehouses.read','vendors.manage','vendors.read',
    'inventory.read','inventory.stock_in','inventory.stock_out','inventory.transfer',
    'inventory.adjust','inventory.reconcile','imei.read','imei.manage',
    'marketplace.read','marketplace.manage','reports.export','imports.run'];

  for (const code of perms)
    await client.query(`INSERT INTO permissions(id,code,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,$1,now(),now()) ON CONFLICT(code) DO NOTHING`, [code]);
  console.log('[seed] Permissions seeded.');

  // Roles
  await client.query(`INSERT INTO roles(id,name,description,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,'ADMIN','Full access',now(),now()) ON CONFLICT(name) DO NOTHING`);
  await client.query(`INSERT INTO roles(id,name,description,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,'STAFF','Read-only',now(),now()) ON CONFLICT(name) DO NOTHING`);

  // Get IDs
  const adminRole = await client.query(`SELECT id FROM roles WHERE name='ADMIN' LIMIT 1`);
  const wildPerm  = await client.query(`SELECT id FROM permissions WHERE code='*' LIMIT 1`);
  const adminRoleId = adminRole.rows[0]?.id;
  const wildPermId  = wildPerm.rows[0]?.id;

  if (!adminRoleId || !wildPermId) throw new Error('ADMIN role or * permission missing');

  // Clear and re-link only the junction tables (not the main tables)
  await client.query(`DELETE FROM "_RolePermissions" WHERE "A"=$1`, [adminRoleId]);
  await client.query(`DELETE FROM "_RolePermissions" WHERE "A" IN (SELECT id FROM roles WHERE name='STAFF')`);
  await client.query(`DELETE FROM "_UserRoles"`);

  // Link ADMIN -> *
  await client.query(`INSERT INTO "_RolePermissions"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING`, [adminRoleId, wildPermId]);

  // Link STAFF -> read perms
  await client.query(`
    INSERT INTO "_RolePermissions"("A","B")
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name='STAFF' AND p.code IN ('products.read','vendors.read','warehouses.read','inventory.read','imei.read','marketplace.read')
    ON CONFLICT DO NOTHING`);

  // Admin user
  const existing = await client.query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const ins = await client.query(`
      INSERT INTO users(id,email,"passwordHash","fullName","isActive","createdAt","updatedAt")
      VALUES(gen_random_uuid()::text,$1,$2,'Administrator',true,now(),now())
      RETURNING id`, [email, hash]);
    userId = ins.rows[0].id;
  }

  // Link user -> ADMIN role
  await client.query(`INSERT INTO "_UserRoles"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING`, [userId, adminRoleId]);

  // Final verification
  const verify = await client.query(`
    SELECT COUNT(*) as cnt FROM users u
    JOIN "_UserRoles" ur ON ur."A"=u.id
    JOIN roles r ON r.id=ur."B"
    JOIN "_RolePermissions" rp ON rp."A"=r.id
    JOIN permissions p ON p.id=rp."B"
    WHERE u.email=$1 AND p.code='*'`, [email]);

  if (parseInt(verify.rows[0]?.cnt) === 0) throw new Error('Verification failed — wildcard not linked');

  console.log(`[seed] ✓ Admin ready: ${email}`);
  await client.end();
}

main().catch(e => { console.error('[seed] FATAL:', e.message); process.exit(1); });
