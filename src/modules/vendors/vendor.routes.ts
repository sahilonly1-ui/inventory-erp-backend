import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { vendorService } from './vendor.service';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40),
  contactPerson: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional(),
  gstin: z.string().max(20).optional(),
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

router.post('/', authorize(PERMISSIONS.VENDORS_MANAGE), validate(createSchema), asyncHandler(async (req: Request, res: Response) => ok(res, await vendorService.create(req.body, actor(req)), 201)));
router.get('/', authorize(PERMISSIONS.VENDORS_READ), asyncHandler(async (_req: Request, res: Response) => ok(res, await vendorService.list())));
router.get('/:id', authorize(PERMISSIONS.VENDORS_READ), validate(idParam, 'params'), asyncHandler(async (req: Request, res: Response) => ok(res, await vendorService.get(req.params.id))));
router.patch('/:id', authorize(PERMISSIONS.VENDORS_MANAGE), validate(idParam, 'params'), validate(updateSchema), asyncHandler(async (req: Request, res: Response) => ok(res, await vendorService.update(req.params.id, req.body, actor(req)))));
router.delete('/:id', authorize(PERMISSIONS.VENDORS_MANAGE), validate(idParam, 'params'), asyncHandler(async (req: Request, res: Response) => { await vendorService.remove(req.params.id, actor(req)); ok(res, { message: 'Vendor deleted (soft)' }); }));
router.get('/:id/stock', authorize(PERMISSIONS.VENDORS_READ), validate(idParam, 'params'), asyncHandler(async (req: Request, res: Response) => ok(res, await vendorService.vendorStock(req.params.id))));
router.get('/:id/aging', authorize(PERMISSIONS.VENDORS_READ), validate(idParam, 'params'), asyncHandler(async (req: Request, res: Response) => ok(res, await vendorService.vendorAging(req.params.id))));

export default router;
