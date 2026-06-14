// Central permission catalog. Seeded into the DB and used by authorize().
// ADMIN holds the WILDCARD, which satisfies every check.
export const PERMISSIONS = {
  // user / rbac
  USERS_CREATE: 'users.create',
  USERS_READ: 'users.read',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',
  USERS_RESTORE: 'users.restore',
  ROLES_MANAGE: 'roles.manage',

  // master data
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_READ: 'products.read',
  PRODUCTS_UPDATE: 'products.update',
  PRODUCTS_DELETE: 'products.delete',
  CATEGORIES_MANAGE: 'categories.manage',
  WAREHOUSES_MANAGE: 'warehouses.manage',
  WAREHOUSES_READ: 'warehouses.read',
  VENDORS_MANAGE: 'vendors.manage',
  VENDORS_READ: 'vendors.read',

  // inventory
  INVENTORY_READ: 'inventory.read',
  INVENTORY_STOCK_IN: 'inventory.stock_in',
  INVENTORY_STOCK_OUT: 'inventory.stock_out',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_RECONCILE: 'inventory.reconcile',

  // imei
  IMEI_READ: 'imei.read',
  IMEI_MANAGE: 'imei.manage',

  // marketplace
  MARKETPLACE_READ: 'marketplace.read',
  MARKETPLACE_MANAGE: 'marketplace.manage',

  // reports + imports
  REPORTS_EXPORT: 'reports.export',
  IMPORTS_RUN: 'imports.run',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS: string[] = Object.values(PERMISSIONS);
export const WILDCARD = '*';
