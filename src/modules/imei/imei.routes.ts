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

// ── Bulk swipe + activate via uploaded Excel list ───────────────────────────
// Body: { rows: [{imei1, swiped?, swipedAt?, activated?, activatedAt?}] }
router.post('/bulk-update', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BadRequestError('rows array required');
  }
  if (rows.length > 5000) throw new BadRequestError('Maximum 5000 rows per upload');

  const results: { imei: string; status: 'ok' | 'not_found' | 'error'; msg?: string }[] = [];

  for (const row of rows) {
    const imei1 = String(row.imei1 || row.imei || '').trim();
    if (!imei1) { results.push({ imei: imei1, status: 'error', msg: 'Empty IMEI' }); continue; }

    try {
      const rec = await prisma.imeiInventory.findFirst({ where: { imei1, isDeleted: false } });
      if (!rec) { results.push({ imei: imei1, status: 'not_found' }); continue; }

      const patch: Record<string, any> = { updatedBy: actor.id };
      if (row.swiped !== undefined) {
        patch.swiped = Boolean(row.swiped);
        patch.swipedAt = row.swiped
          ? (row.swipedAt ? new Date(row.swipedAt) : new Date())
          : null;
      }
      if (row.activated !== undefined) {
        patch.activated = Boolean(row.activated);
        patch.activatedAt = row.activated
          ? (row.activatedAt ? new Date(row.activatedAt) : new Date())
          : null;
      }

      await prisma.imeiInventory.update({ where: { id: rec.id }, data: patch });
      results.push({ imei: imei1, status: 'ok' });
    } catch (e: any) {
      results.push({ imei: imei1, status: 'error', msg: e.message?.slice(0, 80) });
    }
  }

  const ok  = results.filter(r => r.status === 'ok').length;
  const nf  = results.filter(r => r.status === 'not_found').length;
  const err = results.filter(r => r.status === 'error').length;
  ok(res, { processed: rows.length, ok, not_found: nf, errors: err, results });
}));

// ── Toggle swiped only ───────────────────────────────────────────────────────
router.patch('/:id/swiped', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const { swiped, swipedAt } = req.body;
  if (typeof swiped !== 'boolean') throw new BadRequestError('swiped must be boolean');
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const resolvedSwipedAt = swiped
    ? (swipedAt ? new Date(swipedAt) : new Date())
    : null;
  const updated = await prisma.imeiInventory.update({
    where: { id: req.params.id },
    data: { swiped, swipedAt: resolvedSwipedAt, updatedBy: actor.id },
  });
  ok(res, { id: updated.id, swiped: updated.swiped, swipedAt: updated.swipedAt });
}));

// ── Toggle activated (unit demo'd/activated by customer) ─────────────────────
router.patch('/:id/activated', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const { activated, activatedAt } = req.body;
  if (typeof activated !== 'boolean') throw new BadRequestError('activated must be boolean');
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const resolvedActivatedAt = activated
    ? (activatedAt ? new Date(activatedAt) : new Date())
    : null;
  const updated = await prisma.imeiInventory.update({
    where: { id: req.params.id },
    data: { activated, activatedAt: resolvedActivatedAt, updatedBy: actor.id },
  });
  ok(res, { id: updated.id, activated: updated.activated, activatedAt: updated.activatedAt });
}));

router.get('/', authorize(PERMISSIONS.IMEI_READ), validate(imeiQuerySchema, 'query'), imeiController.list);
router.get('/:imei', authorize(PERMISSIONS.IMEI_READ), validate(imeiParamSchema, 'params'), imeiController.lookup);

export default router;
