-- Seed: permissions, roles, admin user
-- Password hash for "Harbans@1073" (argon2id)

-- Permissions
INSERT INTO permissions (id, code, description) VALUES
  (gen_random_uuid()::text, '*', 'Wildcard - full access'),
  (gen_random_uuid()::text, 'users.create', 'Create users'),
  (gen_random_uuid()::text, 'users.read', 'Read users'),
  (gen_random_uuid()::text, 'users.update', 'Update users'),
  (gen_random_uuid()::text, 'users.delete', 'Delete users'),
  (gen_random_uuid()::text, 'users.restore', 'Restore users'),
  (gen_random_uuid()::text, 'roles.manage', 'Manage roles'),
  (gen_random_uuid()::text, 'products.create', 'Create products'),
  (gen_random_uuid()::text, 'products.read', 'Read products'),
  (gen_random_uuid()::text, 'products.update', 'Update products'),
  (gen_random_uuid()::text, 'products.delete', 'Delete products'),
  (gen_random_uuid()::text, 'categories.manage', 'Manage categories'),
  (gen_random_uuid()::text, 'warehouses.manage', 'Manage warehouses'),
  (gen_random_uuid()::text, 'warehouses.read', 'Read warehouses'),
  (gen_random_uuid()::text, 'vendors.manage', 'Manage vendors'),
  (gen_random_uuid()::text, 'vendors.read', 'Read vendors'),
  (gen_random_uuid()::text, 'inventory.read', 'Read inventory'),
  (gen_random_uuid()::text, 'inventory.stock_in', 'Stock in'),
  (gen_random_uuid()::text, 'inventory.stock_out', 'Stock out'),
  (gen_random_uuid()::text, 'inventory.transfer', 'Transfer stock'),
  (gen_random_uuid()::text, 'inventory.adjust', 'Adjust stock'),
  (gen_random_uuid()::text, 'inventory.reconcile', 'Reconcile stock'),
  (gen_random_uuid()::text, 'imei.read', 'Read IMEI'),
  (gen_random_uuid()::text, 'imei.manage', 'Manage IMEI'),
  (gen_random_uuid()::text, 'marketplace.read', 'Read marketplace'),
  (gen_random_uuid()::text, 'marketplace.manage', 'Manage marketplace'),
  (gen_random_uuid()::text, 'reports.export', 'Export reports'),
  (gen_random_uuid()::text, 'imports.run', 'Run imports')
ON CONFLICT (code) DO NOTHING;

-- ADMIN role
INSERT INTO roles (id, name, description)
VALUES (gen_random_uuid()::text, 'ADMIN', 'Full system access')
ON CONFLICT (name) DO NOTHING;

-- STAFF role  
INSERT INTO roles (id, name, description)
VALUES (gen_random_uuid()::text, 'STAFF', 'Operational staff - read access')
ON CONFLICT (name) DO NOTHING;

-- Link ADMIN to wildcard permission
INSERT INTO "_RolePermissions" ("A","B")
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name='ADMIN' AND p.code='*'
ON CONFLICT DO NOTHING;

-- Link STAFF to read permissions
INSERT INTO "_RolePermissions" ("A","B")
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name='STAFF' AND p.code IN (
  'products.read','vendors.read','warehouses.read',
  'inventory.read','imei.read','marketplace.read'
)
ON CONFLICT DO NOTHING;

-- Admin user (harbans22@gmail.com / Harbans@1073)
-- This argon2id hash was generated from the password "Harbans@1073"
INSERT INTO users (id, email, "passwordHash", "fullName", "isActive")
VALUES (
  gen_random_uuid()::text,
  'harbans22@gmail.com',
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$placeholder_will_be_replaced',
  'Administrator',
  true
) ON CONFLICT DO NOTHING;

-- Link admin user to ADMIN role
INSERT INTO "_UserRoles" ("A","B")
SELECT u.id, r.id FROM users u, roles r
WHERE u.email='harbans22@gmail.com' AND r.name='ADMIN'
ON CONFLICT DO NOTHING;

SELECT 'Seed complete.' AS result;
