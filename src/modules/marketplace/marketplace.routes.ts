import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { marketplaceService } from './marketplace.service';
import { createOrdersSchema, dispatchSchema, cancelSchema, returnSchema, listOrdersSchema, orderIdParam } from './marketplace.validator';

const actor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, ip: req.ip ?? null };
};

const router = Router();
router.use(authenticate);

router.post('/orders', authorize(PERMISSIONS.MARKETPLACE_MANAGE), validate(createOrdersSchema), asyncHandler(async (req: Request, res: Response) => ok(res, await marketplaceService.createOrders(req.body.orders, actor(req)), 201)));
router.get('/orders', authorize(PERMISSIONS.MARKETPLACE_READ), validate(listOrdersSchema, 'query'), asyncHandler(async (req: Request, res: Response) => ok(res, await marketplaceService.list(req.query as never))));
router.get('/orders/:id', authorize(PERMISSIONS.MARKETPLACE_READ), validate(orderIdParam, 'params'), asyncHandler(async (req: Request, res: Response) => ok(res, await marketplaceService.get(req.params.id))));
router.post('/orders/:id/dispatch', authorize(PERMISSIONS.MARKETPLACE_MANAGE), validate(orderIdParam, 'params'), validate(dispatchSchema), asyncHandler(async (req: Request, res: Response) => ok(res, await marketplaceService.dispatch(req.params.id, req.body.warehouseId, actor(req)))));
router.post('/orders/:id/cancel', authorize(PERMISSIONS.MARKETPLACE_MANAGE), validate(orderIdParam, 'params'), validate(cancelSchema), asyncHandler(async (req: Request, res: Response) => ok(res, await marketplaceService.cancel(req.params.id, req.body.reason, actor(req)))));
router.post('/orders/:id/return', authorize(PERMISSIONS.MARKETPLACE_MANAGE), validate(orderIdParam, 'params'), validate(returnSchema), asyncHandler(async (req: Request, res: Response) => ok(res, await marketplaceService.returnOrder(req.params.id, req.body.reason, req.body.items, actor(req)))));

export default router;
