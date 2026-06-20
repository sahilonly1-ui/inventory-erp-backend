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
  ok(res, await auditService.list({ page, limit, entityName, action }));
}));

router.post('/:id/restore', authorize(PERMISSIONS.PRODUCTS_UPDATE), asyncHandler(async (req, res) => {
  ok(res, await auditService.restore(req.params.id, actor(req)));
}));

export default router;
