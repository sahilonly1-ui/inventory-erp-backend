import { prisma } from '../../config/prisma';
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

// ── Edit a stock transaction (update vendor/remarks) ─────────────────────────
router.patch('/transactions/:id', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  const { vendorId, remarks } = req.body;
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const patch: any = {};
  if (vendorId !== undefined) patch.vendorId = vendorId || null;
  if (remarks !== undefined) patch.remarks = remarks;
  const txn = await prisma.inventoryTransaction.update({ where: { id: req.params.id }, data: patch });
  await writeAudit(prisma, { userId: actor.id, action: 'UPDATE', entityName: 'inventory_transactions', entityId: req.params.id, newValue: patch, ipAddress: actor.ip });
  ok(res, txn);
}));

// ── Restore a deleted stock transaction from audit log ───────────────────────
router.post('/transactions/restore/:auditId', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  const auditLog = await prisma.auditLog.findUnique({ where: { id: req.params.auditId } });
  if (!auditLog || auditLog.action !== 'DELETE' || auditLog.entityName !== 'inventory_transactions') {
    throw new BadRequestError('Audit log not found or is not a transaction deletion');
  }
  const old = auditLog.oldValue as any;
  if (!old?.productId || !old?.warehouseId) {
    throw new BadRequestError('Insufficient data to restore — transaction was deleted before restore feature was enabled');
  }

  await prisma.$transaction(async (tx) => {
    // Re-create the inventory transaction
    const restored = await tx.inventoryTransaction.create({
      data: {
        productId: old.productId, warehouseId: old.warehouseId,
        type: old.type as TransactionType, quantity: Number(old.quantity),
        vendorId: old.vendorId ?? null,
        remarks: `RESTORED — ${old.remarks ?? ''} (audit: ${auditLog.id.slice(0, 8)})`,
        createdBy: actor.id,
      }
    });
    // Restore the stock level
    await tx.stockLevel.updateMany({
      where: { productId: old.productId, warehouseId: old.warehouseId },
      data: { quantity: { increment: Number(old.quantity) } },
    });
    // Write restore audit
    await writeAudit(tx, {
      userId: actor.id, action: 'CREATE', entityName: 'inventory_transactions', entityId: restored.id,
      oldValue: { restoredFromAuditId: auditLog.id }, newValue: { restored: true, product: old.product },
      ipAddress: actor.ip,
    });
  });
  ok(res, { restored: true, auditId: req.params.auditId });
}));


// ── Fetch full entry detail for editing (products + IMEIs per transaction) ──
router.get('/transactions/entry-detail', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) throw new BadRequestError('ids query param required');

  const txns = await prisma.inventoryTransaction.findMany({
    where: { id: { in: ids } },
    include: {
      product: { select: { id: true, ean: true, model: true, brand: true, imeiRequired: true } },
      vendor:  { select: { id: true, name: true } },
      warehouse: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // For each transaction, fetch current IN_STOCK IMEIs by productId+warehouseId+supplier
  // No time window — so entries from days ago can be edited correctly.
  const enriched = await Promise.all(txns.map(async (t) => {
    let imeis: { id: string; imei1: string; imeiType: string; status: string }[] = [];
    if (t.product.imeiRequired && t.quantity > 0) {
      // Strategy 1: find IMEIs created within ±30min of this transaction
      // This correctly isolates THIS batch even if same product was stocked multiple times
      const since = new Date(t.createdAt.getTime() - 30 * 60_000);
      const until = new Date(t.createdAt.getTime() + 30 * 60_000);
      imeis = await prisma.imeiInventory.findMany({
        where: {
          productId: t.productId,
          warehouseId: t.warehouseId,
          isDeleted: false,
          status: 'IN_STOCK',
          createdAt: { gte: since, lte: until },
        },
        select: { id: true, imei1: true, imeiType: true, status: true },
        orderBy: { createdAt: 'asc' },
        take: Math.abs(t.quantity),
      });
      // Strategy 2 fallback: if time window finds nothing (e.g. old entries with clock skew),
      // just get the oldest IN_STOCK IMEIs for this product up to the quantity
      if (imeis.length === 0) {
        imeis = await prisma.imeiInventory.findMany({
          where: {
            productId: t.productId,
            warehouseId: t.warehouseId,
            isDeleted: false,
            status: 'IN_STOCK',
          },
          select: { id: true, imei1: true, imeiType: true, status: true },
          orderBy: { createdAt: 'asc' },
          take: Math.abs(t.quantity),
        });
      }
    }
    return {
      id: t.id,
      productId: t.product.id,
      ean: t.product.ean,
      model: t.product.model,
      brand: t.product.brand,
      imeiRequired: t.product.imeiRequired,
      quantity: t.quantity,
      remarks: t.remarks,
      vendorId: t.vendor?.id ?? null,
      vendorName: t.vendor?.name ?? null,
      warehouseId: t.warehouseId,
      warehouseName: t.warehouse.name,
      createdAt: t.createdAt,
      imeis,
    };
  }));

  ok(res, { transactions: enriched });
}));


// ── Edit Session store (server-side, survives page refresh, 24h TTL) ───────
// Stores the full draft row list for a stock-in edit so localStorage isn't needed.
const EDIT_SESSIONS = new Map<string, { data: any; expires: number }>();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

router.post('/edit-sessions', authorize(PERMISSIONS.INVENTORY_STOCK_IN), asyncHandler(async (req: Request, res: Response) => {
  const id = `es_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  EDIT_SESSIONS.set(id, { data: req.body, expires: Date.now() + SESSION_TTL });
  // Prune expired sessions
  for (const [k, v] of EDIT_SESSIONS) { if (v.expires < Date.now()) EDIT_SESSIONS.delete(k); }
  ok(res, { sessionId: id });
}));

router.get('/edit-sessions/:id', authorize(PERMISSIONS.INVENTORY_STOCK_IN), asyncHandler(async (req: Request, res: Response) => {
  const entry = EDIT_SESSIONS.get(req.params.id);
  if (!entry || entry.expires < Date.now()) throw new BadRequestError('Edit session not found or expired');
  EDIT_SESSIONS.delete(req.params.id); // consume once
  ok(res, entry.data);
}));

// ── Bulk-delete a supplier's full entry (single grouped audit record) ────────
router.post('/transactions/bulk-delete', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  ok(res, await inventoryController.bulkReverseTransactions(req, res));
}));

// ── Reverse / delete a stock transaction ─────────────────────────────────────
router.delete('/transactions/:id', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  const actor = { id: req.user!.id, ip: req.ip ?? null };
  ok(res, await inventoryService.reverseTransaction(req.params.id, actor));
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
