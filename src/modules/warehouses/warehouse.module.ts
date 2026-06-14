import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { NotFoundError, UnauthorizedError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40),
  address: z.string().max(300).optional(),
});
const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, 'No fields');
const idParam = z.object({ id: z.string().uuid() });

const actor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, ip: req.ip ?? null };
};

const router = Router();
router.use(authenticate);

router.post('/', authorize(PERMISSIONS.WAREHOUSES_MANAGE), validate(createSchema), asyncHandler(async (req: Request, res: Response) => {
  const a = actor(req);
  const wh = await prisma.$transaction(async (tx) => {
    const created = await tx.warehouse.create({ data: { ...req.body, createdBy: a.id } });
    await writeAudit(tx, { userId: a.id, action: 'CREATE', entityName: 'warehouses', entityId: created.id, newValue: req.body, ipAddress: a.ip });
    return created;
  });
  ok(res, wh, 201);
}));

router.get('/', authorize(PERMISSIONS.WAREHOUSES_READ), asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await prisma.warehouse.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' } }));
}));

router.patch('/:id', authorize(PERMISSIONS.WAREHOUSES_MANAGE), validate(idParam, 'params'), validate(updateSchema), asyncHandler(async (req: Request, res: Response) => {
  const a = actor(req);
  const existing = await prisma.warehouse.findFirst({ where: { id: req.params.id, isDeleted: false } });
  if (!existing) throw new NotFoundError('Warehouse not found');
  const wh = await prisma.$transaction(async (tx) => {
    const updated = await tx.warehouse.update({ where: { id: req.params.id }, data: { ...req.body, updatedBy: a.id } });
    await writeAudit(tx, { userId: a.id, action: 'UPDATE', entityName: 'warehouses', entityId: req.params.id, newValue: req.body, ipAddress: a.ip });
    return updated;
  });
  ok(res, wh);
}));

router.delete('/:id', authorize(PERMISSIONS.WAREHOUSES_MANAGE), validate(idParam, 'params'), asyncHandler(async (req: Request, res: Response) => {
  const a = actor(req);
  const existing = await prisma.warehouse.findFirst({ where: { id: req.params.id, isDeleted: false } });
  if (!existing) throw new NotFoundError('Warehouse not found');
  await prisma.$transaction(async (tx) => {
    await tx.warehouse.update({ where: { id: req.params.id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: a.id } });
    await writeAudit(tx, { userId: a.id, action: 'DELETE', entityName: 'warehouses', entityId: req.params.id, ipAddress: a.ip });
  });
  ok(res, { message: 'Warehouse deleted (soft)' });
}));

export default router;
