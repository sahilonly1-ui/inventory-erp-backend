import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { inventoryService } from './inventory.service';
import { inventoryController } from './inventory.controller';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import {
  stockInSchema, stockOutSchema, adjustSchema, transferSchema, openingStockSchema,
  stockQuerySchema, ledgerQuerySchema, reconcileSchema, eanLookupSchema,
} from './inventory.validator';

const router = Router();
router.use(authenticate);

router.post('/stock-in',       authorize(PERMISSIONS.INVENTORY_STOCK_IN),    validate(stockInSchema),              inventoryController.stockIn);
router.post('/stock-out',      authorize(PERMISSIONS.INVENTORY_STOCK_OUT),   validate(stockOutSchema),             inventoryController.stockOut);
router.post('/adjust',         authorize(PERMISSIONS.INVENTORY_ADJUST),      validate(adjustSchema),               inventoryController.adjust);
router.post('/transfer',       authorize(PERMISSIONS.INVENTORY_TRANSFER),    validate(transferSchema),             inventoryController.transfer);
router.post('/reset-all-stock', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req, res) => ok(res, await inventoryService.resetAllStock({ id: req.user!.id, ip: req.ip ?? null }))));
router.post('/opening-stock',  authorize(PERMISSIONS.INVENTORY_STOCK_IN),    validate(openingStockSchema),         inventoryController.openingStock);
router.post('/reconcile',      authorize(PERMISSIONS.INVENTORY_RECONCILE),   validate(reconcileSchema),            inventoryController.reconcile);

router.get('/stock',  authorize(PERMISSIONS.INVENTORY_READ), validate(stockQuerySchema,  'query'), inventoryController.getStock);
router.get('/ledger', authorize(PERMISSIONS.INVENTORY_READ), validate(ledgerQuerySchema, 'query'), inventoryController.getLedger);
router.get('/lookup', authorize(PERMISSIONS.INVENTORY_READ), validate(eanLookupSchema,   'query'), inventoryController.lookup);

export default router;

// ── Session-based scanning endpoints ─────────────────────────────────────────
// A "session" is a single stock-in or stock-out document (SIN/SOUT).
// The frontend creates a session, scans products/IMEIs into it, then commits.

router.post('/sessions', authorize(PERMISSIONS.INVENTORY_STOCK_IN), asyncHandler(async (req: Request, res: Response) => {
  const { type, warehouseId, vendorId, remarks } = req.body;
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  ok(res, await inventoryService.createSession({ type, warehouseId, vendorId, remarks }, actor), 201);
}));

router.get('/sessions', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(100, parseInt(String(req.query.limit || '30')) || 30);
  const type = req.query.type ? String(req.query.type) : undefined;
  ok(res, await inventoryService.listSessions({ limit, type }));
}));

router.get('/sessions/:id', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  ok(res, await inventoryService.getSession(req.params.id));
}));

router.post('/sessions/:id/lines', authorize(PERMISSIONS.INVENTORY_STOCK_IN), asyncHandler(async (req: Request, res: Response) => {
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  ok(res, await inventoryService.addSessionLine(req.params.id, req.body, actor));
}));

router.post('/sessions/:id/commit', authorize(PERMISSIONS.INVENTORY_STOCK_IN), asyncHandler(async (req: Request, res: Response) => {
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  ok(res, await inventoryService.commitSession(req.params.id, actor));
}));

router.delete('/sessions/:id', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  ok(res, await inventoryService.cancelSession(req.params.id, actor));
}));

// ── Daily Summary ─────────────────────────────────────────────────────────────
router.get('/daily-summary', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  const date = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
  ok(res, await inventoryService.dailySummary(date));
}));

// ── Enhanced dashboard stats ──────────────────────────────────────────────────
router.get('/dashboard-stats', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  ok(res, await inventoryService.dashboardStats());
}));
