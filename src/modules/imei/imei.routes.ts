import { Router } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { prisma } from '../../config/prisma';
import { ok } from '../../common/apiResponse';
import { BadRequestError } from '../../common/errors';
import { imeiController } from './imei.controller';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import {
  receiveImeiSchema, dispatchImeiSchema, changeStatusSchema, imeiParamSchema, imeiQuerySchema,
} from './imei.validator';

const router = Router();
router.use(authenticate);

router.post('/receive', authorize(PERMISSIONS.INVENTORY_STOCK_IN), validate(receiveImeiSchema), imeiController.receive);
router.post('/dispatch', authorize(PERMISSIONS.INVENTORY_STOCK_OUT), validate(dispatchImeiSchema), imeiController.dispatch);
router.patch('/:imei/status', authorize(PERMISSIONS.IMEI_MANAGE), validate(imeiParamSchema, 'params'), validate(changeStatusSchema), imeiController.changeStatus);

// ── Toggle swiped only ───────────────────────────────────────────────────────
router.patch('/:id/swiped', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const { swiped } = req.body;
  if (typeof swiped !== 'boolean') throw new BadRequestError('swiped must be boolean');
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const updated = await prisma.imeiInventory.update({
    where: { id: req.params.id },
    data: { swiped, swipedAt: swiped ? new Date() : null, updatedBy: actor.id },
  });
  ok(res, { id: updated.id, swiped: updated.swiped, swipedAt: updated.swipedAt });
}));

// ── Toggle activated (unit demo'd/activated by customer) ─────────────────────
router.patch('/:id/activated', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const { activated } = req.body;
  if (typeof activated !== 'boolean') throw new BadRequestError('activated must be boolean');
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const updated = await prisma.imeiInventory.update({
    where: { id: req.params.id },
    data: { activated, activatedAt: activated ? new Date() : null, updatedBy: actor.id },
  });
  ok(res, { id: updated.id, activated: updated.activated, activatedAt: updated.activatedAt });
}));

router.get('/', authorize(PERMISSIONS.IMEI_READ), validate(imeiQuerySchema, 'query'), imeiController.list);
router.get('/:imei', authorize(PERMISSIONS.IMEI_READ), validate(imeiParamSchema, 'params'), imeiController.lookup);

export default router;
