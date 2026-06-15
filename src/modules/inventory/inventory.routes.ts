import { Router } from 'express';
import { inventoryController } from './inventory.controller';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import {
  stockInSchema, stockOutSchema, adjustSchema, transferSchema, openingStockSchema,
  stockQuerySchema, ledgerQuerySchema, reconcileSchema, eanLookupSchema,
} from './inventory.validator';

const actor = (req: Request) => ({ id: req.user!.id, ip: req.ip ?? null });
const router = Router();
router.use(authenticate);

router.post('/stock-in', authorize(PERMISSIONS.INVENTORY_STOCK_IN), validate(stockInSchema), inventoryController.stockIn);
router.post('/stock-out', authorize(PERMISSIONS.INVENTORY_STOCK_OUT), validate(stockOutSchema), inventoryController.stockOut);
router.post('/adjust', authorize(PERMISSIONS.INVENTORY_ADJUST), validate(adjustSchema), inventoryController.adjust);
router.post('/transfer', authorize(PERMISSIONS.INVENTORY_TRANSFER), validate(transferSchema), inventoryController.transfer);

router.get('/stock', authorize(PERMISSIONS.INVENTORY_READ), validate(stockQuerySchema, 'query'), inventoryController.getStock);
router.get('/ledger', authorize(PERMISSIONS.INVENTORY_READ), validate(ledgerQuerySchema, 'query'), inventoryController.getLedger);
router.get('/lookup', authorize(PERMISSIONS.INVENTORY_READ), validate(eanLookupSchema, 'query'), inventoryController.lookup);

router.post('/reconcile', authorize(PERMISSIONS.INVENTORY_RECONCILE), validate(reconcileSchema), inventoryController.reconcile);

router.post('/opening-stock', authorize(PERMISSIONS.INVENTORY_STOCK_IN), validate(openingStockSchema), asyncHandler(async (req: Request, res: Response) => {
  ok(res, await inventoryService.openingStock(req.body, actor(req)), 201);
}));

export default router;
