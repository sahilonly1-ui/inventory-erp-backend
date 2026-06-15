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

  // PRISMA IMPLICIT M2M COLUMN ORDER (alphabetical by model name):
  // _RolePermissions: A=Permission.id, B=Role.id  (P < R)
  // _UserRoles:       A=Role.id,       B=User.id   (R < U)

  console.log('[seed] Rebuilding permissions with correct Prisma M2M column order...');

  // 1. Permissions
  const perms = ['*','users.create','users.read','users.update','users.delete','users.restore',
    'roles.manage','products.create','products.read','products.update','products.delete',
    'categories.manage','warehouses.manage','warehouses.read','vendors.manage','vendors.read',
    'inventory.read','inventory.stock_in','inventory.stock_out','inventory.transfer',
    'inventory.adjust','inventory.reconcile','imei.read','imei.manage',
    'marketplace.read','marketplace.manage','reports.export','imports.run'];

  for (const code of perms)
    await client.query(
      `INSERT INTO permissions(id,code,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,$1,now(),now()) ON CONFLICT(code) DO NOTHING`,
      [code]
    );
  console.log('[seed] Permissions seeded.');

  // 2. Roles
  await client.query(`INSERT INTO roles(id,name,description,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,'ADMIN','Full access',now(),now()) ON CONFLICT(name) DO NOTHING`);
  await client.query(`INSERT INTO roles(id,name,description,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,'STAFF','Read-only',now(),now()) ON CONFLICT(name) DO NOTHING`);

  // 3. Get IDs
  const adminRole = await client.query(`SELECT id FROM roles WHERE name='ADMIN' LIMIT 1`);
  const wildPerm  = await client.query(`SELECT id FROM permissions WHERE code='*' LIMIT 1`);
  const adminRoleId = adminRole.rows[0]?.id;
  const wildPermId  = wildPerm.rows[0]?.id;
  if (!adminRoleId || !wildPermId) throw new Error('ADMIN role or * permission missing');
  console.log(`[seed] ADMIN role: ${adminRoleId.slice(0,8)}, * perm: ${wildPermId.slice(0,8)}`);

  // 4. Clear junction tables
  await client.query(`DELETE FROM "_RolePermissions"`);
  await client.query(`DELETE FROM "_UserRoles"`);
  console.log('[seed] Junction tables cleared.');

  // 5. _RolePermissions: A=Permission.id, B=Role.id  (Prisma alphabetical: Permission < Role)
  await client.query(
    `INSERT INTO "_RolePermissions"("A","B") VALUES($1,$2)`,
    [wildPermId, adminRoleId]  // A=permission, B=role
  );
  console.log('[seed] ADMIN -> * linked (A=permId, B=roleId).');

  // STAFF read permissions
  const readPerms = await client.query(
    `SELECT id FROM permissions WHERE code IN ('products.read','vendors.read','warehouses.read','inventory.read','imei.read','marketplace.read')`
  );
  const staffRole = await client.query(`SELECT id FROM roles WHERE name='STAFF' LIMIT 1`);
  const staffRoleId = staffRole.rows[0]?.id;
  if (staffRoleId) {
    for (const row of readPerms.rows) {
      await client.query(
        `INSERT INTO "_RolePermissions"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [row.id, staffRoleId]  // A=permission, B=role
      );
    }
    console.log(`[seed] STAFF -> ${readPerms.rows.length} read perms linked.`);
  }

  // 6. Admin user
  const existing = await client.query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const ins = await client.query(
      `INSERT INTO users(id,email,"passwordHash","fullName","isActive","createdAt","updatedAt") VALUES(gen_random_uuid()::text,$1,$2,'Administrator',true,now(),now()) RETURNING id`,
      [email, hash]
    );
    userId = ins.rows[0].id;
    console.log(`[seed] Admin user created: ${userId.slice(0,8)}`);
  } else {
    console.log(`[seed] Admin user exists: ${userId.slice(0,8)}`);
  }

  // 7. _UserRoles: A=Role.id, B=User.id  (Prisma alphabetical: Role < User)
  await client.query(
    `INSERT INTO "_UserRoles"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [adminRoleId, userId]  // A=role, B=user
  );
  console.log('[seed] User -> ADMIN role linked (A=roleId, B=userId).');

  // 8. Verify Prisma can see it
  const verify = await client.query(`
    SELECT u.email, p.code
    FROM users u
    JOIN "_UserRoles" ur ON ur."B"=u.id
    JOIN roles r ON r.id=ur."A"
    JOIN "_RolePermissions" rp ON rp."B"=r.id
    JOIN permissions p ON p.id=rp."A"
    WHERE u.email=$1 AND p.code='*'`, [email]);

  if (!verify.rows.length) throw new Error('Verification failed — Prisma column order query returned nothing');
  console.log(`[seed] ✓ Verified with Prisma column order. Admin ready: ${email}`);

  await client.end();
}

main().catch(e => { console.error('[seed] FATAL:', e.message); process.exit(1); });
