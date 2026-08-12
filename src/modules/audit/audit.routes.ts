import { Router, Request } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { PERMISSIONS } from '../../constants/permissions';
import { auditService } from './audit.service';

const router = Router();
router.use(authenticate);
const actor = (req: Request) => ({ id: req.user!.id, ip: req.ip ?? null });

router.get('/', authorize(PERMISSIONS.PRODUCTS_READ), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
  const entityName = req.query.entityName ? String(req.query.entityName) : undefined;
  const action = req.query.action ? String(req.query.action) : undefined;
  // Grouped is the default: an ungrouped feed is unreadable once a single
  // stock-in writes a hundred rows. ?grouped=false restores the flat view.
  const grouped = String(req.query.grouped ?? 'true') !== 'false';
  ok(res, grouped
    ? await auditService.listGrouped({ page, limit, entityName, action })
    : await auditService.list({ page, limit, entityName, action }));
}));

router.post('/:id/restore', authorize(PERMISSIONS.PRODUCTS_UPDATE), asyncHandler(async (req, res) => {
  ok(res, await auditService.restore(req.params.id, actor(req)));
}));

// Revert a whole grouped batch. Pass dryRun to preview what would change
// before anything is written.
router.post('/restore-batch', authorize(PERMISSIONS.PRODUCTS_UPDATE), asyncHandler(async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.auditIds) ? req.body.auditIds.filter(Boolean) : [];
  const dryRun = req.body?.dryRun === true;
  ok(res, await auditService.restoreBatch(ids, actor(req), dryRun));
}));

export default router;
