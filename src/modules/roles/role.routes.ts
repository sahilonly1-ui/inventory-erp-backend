import { Router, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { PERMISSIONS, ALL_PERMISSIONS, WILDCARD } from '../../constants/permissions';
import { writeAudit } from '../../common/audit.service';

const router = Router();
router.use(authenticate);

// Grouped for display: the UI shows permissions by area rather than as one
// flat list of 30+ codes.
const GROUPS: { label: string; match: (code: string) => boolean }[] = [
  { label: 'Users & Roles', match: c => c.startsWith('users.') || c.startsWith('roles.') },
  { label: 'Products',      match: c => c.startsWith('products.') || c.startsWith('categories.') },
  { label: 'Inventory',     match: c => c.startsWith('inventory.') },
  { label: 'IMEI',          match: c => c.startsWith('imei.') },
  { label: 'Vendors',       match: c => c.startsWith('vendors.') || c.startsWith('warehouses.') },
  { label: 'Reports',       match: c => c.startsWith('reports.') || c.startsWith('imports.') },
  { label: 'Marketplace',   match: c => c.startsWith('marketplace.') },
];

function groupOf(code: string): string {
  return GROUPS.find(g => g.match(code))?.label ?? 'Other';
}

// GET /roles — roles with their permission codes and how many users hold each
router.get('/', authorize(PERMISSIONS.USERS_READ), asyncHandler(async (_req: Request, res: Response) => {
  const roles = await prisma.role.findMany({
    include: {
      permissions: { select: { code: true } },
      users: { select: { id: true } },
    },
    orderBy: { name: 'asc' },
  });
  ok(res, roles.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions.map(p => p.code),
    userCount: r.users.length,
    isAdmin: r.permissions.some(p => p.code === WILDCARD),
  })));
}));

// GET /roles/permissions — the full catalog, grouped for the UI
router.get('/permissions', authorize(PERMISSIONS.USERS_READ), asyncHandler(async (_req: Request, res: Response) => {
  const codes = ALL_PERMISSIONS;
  const grouped: Record<string, string[]> = {};
  for (const c of codes) {
    const g = groupOf(c);
    (grouped[g] ||= []).push(c);
  }
  ok(res, { groups: Object.entries(grouped).map(([label, items]) => ({ label, permissions: items.sort() })) });
}));

// POST /roles — create a custom role
router.post('/', authorize(PERMISSIONS.ROLES_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim().toUpperCase();
  const description = String(req.body?.description || '').trim() || null;
  const codes: string[] = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  if (!name) throw new BadRequestError('Role name is required');

  const exists = await prisma.role.findUnique({ where: { name } });
  if (exists) throw new BadRequestError(`Role "${name}" already exists`);

  const valid = codes.filter(c => ALL_PERMISSIONS.includes(c));
  const role = await prisma.role.create({
    data: {
      name,
      description,
      permissions: { connect: valid.map(code => ({ code })) },
    },
    include: { permissions: { select: { code: true } } },
  });

  await writeAudit(prisma, { userId: req.user!.id, ipAddress: req.ip ?? null, entityName: 'roles', entityId: role.id, action: 'CREATE', newValue: { name, permissions: valid } });
  ok(res, { id: role.id, name: role.name, permissions: role.permissions.map(p => p.code) });
}));

// PUT /roles/:id/permissions — replace a role's permission set
router.put('/:id/permissions', authorize(PERMISSIONS.ROLES_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  const codes: string[] = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const role = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: { select: { code: true } } } });
  if (!role) throw new NotFoundError('Role not found');

  // The ADMIN role is the system's escape hatch — if its wildcard could be
  // removed, a mis-click would lock every user out of user management.
  if (role.permissions.some(p => p.code === WILDCARD)) {
    throw new BadRequestError('The ADMIN role always has full access and cannot be edited');
  }

  const valid = codes.filter(c => ALL_PERMISSIONS.includes(c));
  const before = role.permissions.map(p => p.code);

  await prisma.role.update({
    where: { id: role.id },
    data: { permissions: { set: valid.map(code => ({ code })) } },
  });

  await writeAudit(prisma, { userId: req.user!.id, ipAddress: req.ip ?? null, entityName: 'roles', entityId: role.id, action: 'UPDATE', oldValue: { permissions: before }, newValue: { permissions: valid } });
  ok(res, { id: role.id, name: role.name, permissions: valid });
}));

// DELETE /roles/:id — only when unused, and never the ADMIN role
router.delete('/:id', authorize(PERMISSIONS.ROLES_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  const role = await prisma.role.findUnique({
    where: { id: req.params.id },
    include: { permissions: { select: { code: true } }, users: { select: { id: true } } },
  });
  if (!role) throw new NotFoundError('Role not found');
  if (role.permissions.some(p => p.code === WILDCARD)) throw new BadRequestError('The ADMIN role cannot be deleted');
  if (role.users.length) throw new BadRequestError(`${role.users.length} user(s) still have this role — reassign them first`);

  await prisma.role.delete({ where: { id: role.id } });
  await writeAudit(prisma, { userId: req.user!.id, ipAddress: req.ip ?? null, entityName: 'roles', entityId: role.id, action: 'DELETE', oldValue: { name: role.name } });
  ok(res, { id: role.id, deleted: true });
}));

export default router;
