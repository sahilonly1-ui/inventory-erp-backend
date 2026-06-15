import { Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { inventoryService } from './inventory.service';
import { reconciliationService } from './reconciliation.service';

const actor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, ip: req.ip ?? null };
};

export const inventoryController = {
  stockIn: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.stockIn(req.body, actor(req)), 201);
  }),
  stockOut: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.stockOut(req.body, actor(req)), 201);
  }),
  adjust: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.adjust(req.body, actor(req)), 201);
  }),

  openingStock: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.openingStock(req.body, actor(req)), 201);
  }),
  transfer: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.transfer(req.body, actor(req)), 201);
  }),
  getStock: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.getStock(req.query as never));
  }),
  getLedger: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.getLedger(req.query as never));
  }),
  lookup: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await inventoryService.lookupByEan(String(req.query.ean)));
  }),
  reconcile: asyncHandler(async (req: Request, res: Response) => {
    const { productId, warehouseId, limit } = req.body;
    if (productId && warehouseId) {
      ok(res, await reconciliationService.reconcileOne(productId, warehouseId));
    } else {
      ok(res, await reconciliationService.reconcileBatch({ productId, warehouseId, limit }));
    }
  }),
};
