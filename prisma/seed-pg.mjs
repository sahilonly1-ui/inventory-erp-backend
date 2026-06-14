import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const argon2 = require('argon2');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PROJECT  = 'xukbgkwagjtzxoobcyuk';
const PASSWORD = 'Harbans1073!';

// Session pooler (5432) handles complex multi-statement logic better than transaction pooler
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

async function run(client, label, sql, params) {
  try {
    const res = await client.query(sql, params);
    console.log(`[seed] ${label} OK`);
    return res;
  } catch (e) {
    console.error(`[seed] ${label} ERROR: ${e.message}`);
    throw e;
  }
}

async function main() {
  const email    = process.env.BOOTSTRAP_ADMIN_EMAIL    || 'harbans22@gmail.com';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Harbans@1073';

  const client = await connect();

  // 1. Clear junction tables (DELETE is safer than TRUNCATE on poolers)
  await run(client, 'clear _RolePermissions', 'DELETE FROM "_RolePermissions"').catch(()=>console.log('[seed] _RolePermissions empty/missing - ok'));
  await run(client, 'clear _UserRoles',       'DELETE FROM "_UserRoles"').catch(()=>console.log('[seed] _UserRoles empty/missing - ok'));

  // 2. Permissions
  const perms = ['*','users.create','users.read','users.update','users.delete','users.restore',
    'roles.manage','products.create','products.read','products.update','products.delete',
    'categories.manage','warehouses.manage','warehouses.read','vendors.manage','vendors.read',
    'inventory.read','inventory.stock_in','inventory.stock_out','inventory.transfer',
    'inventory.adjust','inventory.reconcile','imei.read','imei.manage',
    'marketplace.read','marketplace.manage','reports.export','imports.run'];

  for (const code of perms) {
    await client.query(
      `INSERT INTO permissions(id,code,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,$1,now(),now()) ON CONFLICT(code) DO NOTHING`,
      [code]
    );
  }
  console.log(`[seed] ${perms.length} permissions seeded`);

  // 3. Roles
  await run(client, 'ADMIN role',
    `INSERT INTO roles(id,name,description,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,'ADMIN','Full access',now(),now()) ON CONFLICT(name) DO NOTHING`);
  await run(client, 'STAFF role',
    `INSERT INTO roles(id,name,description,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,'STAFF','Read-only',now(),now()) ON CONFLICT(name) DO NOTHING`);

  // 4. Verify role + permission IDs exist before linking
  const adminRole = await client.query(`SELECT id FROM roles WHERE name='ADMIN' LIMIT 1`);
  const wildPerm  = await client.query(`SELECT id FROM permissions WHERE code='*' LIMIT 1`);
  console.log(`[seed] ADMIN role id=${adminRole.rows[0]?.id?.slice(0,8)}, * perm id=${wildPerm.rows[0]?.id?.slice(0,8)}`);

  if (!adminRole.rows[0] || !wildPerm.rows[0]) {
    throw new Error('ADMIN role or wildcard permission missing after insert');
  }

  // 5. Sanity: confirm the role id is actually queryable (detects stale FK target)
  const roleCheck = await client.query(`SELECT id FROM roles WHERE id=$1`, [adminRole.rows[0].id]);
  console.log(`[seed] role id re-query found ${roleCheck.rowCount} row(s)`);

  // 5b. Link ADMIN -> wildcard (explicit IDs, no join ambiguity)
  await run(client, 'link ADMIN->*',
    `INSERT INTO "_RolePermissions"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [adminRole.rows[0].id, wildPerm.rows[0].id]);

  // 6. Link STAFF -> read perms
  await run(client, 'link STAFF->reads', `
    INSERT INTO "_RolePermissions"("A","B")
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name='STAFF' AND p.code IN ('products.read','vendors.read','warehouses.read','inventory.read','imei.read','marketplace.read')
    ON CONFLICT DO NOTHING`);

  // 7. Admin user
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await run(client, 'admin user',
    `INSERT INTO users(id,email,"passwordHash","fullName","isActive","createdAt","updatedAt")
     VALUES(gen_random_uuid()::text,$1,$2,'Administrator',true,now(),now())
     ON CONFLICT DO NOTHING`, [email, hash]);

  // 8. Verify user exists then link to ADMIN role
  const adminUser = await client.query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [email]);
  console.log(`[seed] admin user id=${adminUser.rows[0]?.id?.slice(0,8)}`);

  if (!adminUser.rows[0]) throw new Error('Admin user missing after insert');

  await run(client, 'link user->ADMIN',
    `INSERT INTO "_UserRoles"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [adminUser.rows[0].id, adminRole.rows[0].id]);

  // 9. Final verification
  const check = await client.query(`
    SELECT u.email, r.name as role, COUNT(rp.*) as perms
    FROM users u
    JOIN "_UserRoles" ur ON ur."A"=u.id
    JOIN roles r ON r.id=ur."B"
    LEFT JOIN "_RolePermissions" rp ON rp."A"=r.id
    WHERE u.email=$1
    GROUP BY u.email, r.name`, [email]);

  console.log('[seed] VERIFICATION:', JSON.stringify(check.rows));
  console.log(`[seed] ✓ Admin ready: ${email}`);

  await client.end();
}

main().catch(e => { console.error('[seed] FATAL:', e.message); process.exit(1); });
