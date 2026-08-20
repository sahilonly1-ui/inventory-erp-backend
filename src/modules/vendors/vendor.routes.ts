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
  state: z.string().min(1).max(60).optional(),
  contactPerson: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal('')),
  gstin: z.string().max(20).optional(),
  address: z.string().max(300).optional(),
  notes: z.string().max(500).optional(),
});
const updateSchema = createSchema.partial().refine(v => Object.keys(v).length > 0, 'No fields');
const idParam = z.object({ id: z.string().uuid() });
const actor = (req: Request) => { if (!req.user) throw new UnauthorizedError(); return { id: req.user.id, ip: req.ip ?? null }; };

const router = Router();
router.use(authenticate);

// List + search
router.get('/',         authorize(PERMISSIONS.VENDORS_READ),   asyncHandler(async (req, res) => {
  const q = req.query.q ? String(req.query.q) : '';
  ok(res, q ? await vendorService.search(q) : await vendorService.list());
}));

// Smart find-or-create (Stock In/Out auto-create)
router.post('/find-or-create', authorize(PERMISSIONS.VENDORS_READ), asyncHandler(async (req: Request, res: Response) => {
  const { name, state, allowWithoutState } = req.body;
  ok(res, await vendorService.findOrCreate(name, state, actor(req), allowWithoutState === true));
}));

// Bulk clear all
router.delete('/clear-all', authorize(PERMISSIONS.VENDORS_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  ok(res, await vendorService.clearAll(actor(req)));
}));

// Standard CRUD
router.post('/',       authorize(PERMISSIONS.VENDORS_MANAGE), validate(createSchema), asyncHandler(async (req, res) => ok(res, await vendorService.create(req.body, actor(req)), 201)));
router.get('/:id',     authorize(PERMISSIONS.VENDORS_READ),   validate(idParam, 'params'), asyncHandler(async (req, res) => ok(res, await vendorService.get(req.params.id))));
router.patch('/:id',   authorize(PERMISSIONS.VENDORS_MANAGE), validate(idParam, 'params'), validate(updateSchema), asyncHandler(async (req, res) => ok(res, await vendorService.update(req.params.id, req.body, actor(req)))));
router.delete('/:id',  authorize(PERMISSIONS.VENDORS_MANAGE), validate(idParam, 'params'), asyncHandler(async (req, res) => { await vendorService.remove(req.params.id, actor(req)); ok(res, { message: 'Deleted' }); }));
router.get('/:id/stock', authorize(PERMISSIONS.VENDORS_READ), validate(idParam, 'params'), asyncHandler(async (req, res) => ok(res, await vendorService.vendorStock(req.params.id))));

export default router;
