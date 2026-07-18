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

// ── Stock Report — brand-wise Qty / Retail (unswiped) / Activated (swiped) ──
router.get('/stock-report', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  // Support multiple brands/categories via comma-separated values
  const categoryIds = req.query.categoryId
    ? String(req.query.categoryId).split(',').filter(Boolean)
    : [];
  const brands = req.query.brand
    ? String(req.query.brand).split(',').filter(Boolean)
    : [];
  const productWhere: any = { isDeleted: false };
  if (categoryIds.length === 1)  productWhere.categoryId = categoryIds[0];
  else if (categoryIds.length > 1) productWhere.categoryId = { in: categoryIds };
  if (brands.length === 1)  productWhere.brand = brands[0];
  else if (brands.length > 1) productWhere.brand = { in: brands };
  const products = await prisma.product.findMany({
    where: { ...productWhere, stockLevels: { some: { quantity: { gt: 0 } } } },
    include: {
      stockLevels: { select: { quantity: true } },
      category:    { select: { id: true, name: true } },
    },
    orderBy: [{ brand: 'asc' }, { model: 'asc' }],
  });
  // Query ALL products — don't filter by imeiRequired (may be false for phones)
  const imeiProductIds = products.map(p => p.id);
  // Use raw SQL — bypasses Prisma client cache, always reflects actual DB schema
  type ImeiCount = { productId: string; total: bigint; activated: bigint };
  const imeiRaw = await prisma.$queryRaw<ImeiCount[]>`
    SELECT
      "productId",
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE activated = true) AS activated
    FROM imei_inventory
    WHERE "productId" = ANY(${imeiProductIds}::text[])
      AND "isDeleted" = false
      AND status = 'IN_STOCK'
    GROUP BY "productId"
  `;
  const imeiMap = new Map<string, { total: number; activated: number }>();
  for (const row of imeiRaw) {
    imeiMap.set(row.productId, {
      total:     Number(row.total),
      activated: Number(row.activated),
    });
  }
  const rows = products.map(p => {
    const totalStock = p.stockLevels.reduce((s, sl) => s + sl.quantity, 0);
    if (totalStock <= 0) return null;
    let totalQty = totalStock, activated = 0, retail = totalStock;
    // Use IMEI counts if records exist for this product
    // (don't rely on imeiRequired flag — may be false even for phones due to data issue)
    const imei = imeiMap.get(p.id);
    if (imei && imei.total > 0) {
      totalQty  = imei.total;
      activated = imei.activated;
      retail    = imei.total - imei.activated;
    }
    return { productId: p.id, ean: p.ean, model: p.model, brand: p.brand,
      category: (p as any).category?.name ?? '', categoryId: p.categoryId ?? '',
      imeiRequired: p.imeiRequired, totalQty, retail, activated };
  }).filter(Boolean);
  const categories = await prisma.productCategory.findMany({
    where: { isDeleted: false }, select: { id: true, name: true }, orderBy: { name: 'asc' },
  });
  const brandsRaw = await prisma.product.groupBy({
    by: ['brand'],
    where: { isDeleted: false, stockLevels: { some: { quantity: { gt: 0 } } } },
    orderBy: { brand: 'asc' },
  });
  ok(res, { rows, categories, brands: brandsRaw.map(b => b.brand).filter(Boolean) });
}));

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

  // For each transaction, fetch IMEIs — no imeiRequired gate (may be false in DB).
  const enriched = await Promise.all(txns.map(async (t) => {
    let imeis: { id: string; imei1: string; imeiType: string; status: string }[] = [];
    if (t.quantity > 0) {
      // PRIMARY: stockInTxnId — set at scan time, exact match always
      imeis = await prisma.imeiInventory.findMany({
        where: { stockInTxnId: t.id, isDeleted: false },
        select: { id: true, imei1: true, imeiType: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      // LEGACY: for entries before stockInTxnId was added
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
      imeiRequired: t.product.imeiRequired || imeis.length > 0, // true if product says so OR IMEIs exist
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


// ── Admin: full purge — delete ALL imei + transaction data (fresh start) ────
router.post('/admin/cleanup-orphaned-imeis', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  const { purgeAll } = req.body;

  if (purgeAll) {
    // FULL PURGE: delete ALL imei_inventory and ALL inventory_transactions
    // Resets stock levels to 0 as well. Used for a clean slate.
    await prisma.$transaction(async (tx) => {
      await tx.imeiInventory.deleteMany({});
      await tx.inventoryTransaction.deleteMany({});
      await tx.stockLevel.updateMany({ data: { quantity: 0 } });
    });
    ok(res, { cleaned: 'ALL', message: 'Full purge complete — all IMEI records, transactions and stock levels reset to zero' });
    return;
  }

  // SELECTIVE PURGE: remove orphaned IMEIs and their ghost transactions
  // Step 1: Soft-delete IMEI records that shouldn't exist
  const allImeis = await prisma.imeiInventory.findMany({
    where: { isDeleted: false },
    select: { id: true, imei1: true, productId: true, warehouseId: true, stockInTxnId: true }
  });

  const orphanedIds: string[] = [];
  for (const ii of allImeis) {
    if (ii.stockInTxnId) {
      // Check if linked transaction still exists
      const txn = await prisma.inventoryTransaction.findUnique({ where: { id: ii.stockInTxnId } });
      if (!txn) orphanedIds.push(ii.id);
    } else {
      // No transaction link — check if any STOCK_IN txn exists for this product
      const txn = await prisma.inventoryTransaction.findFirst({
        where: { productId: ii.productId, warehouseId: ii.warehouseId, type: 'STOCK_IN', quantity: { gt: 0 } }
      });
      if (!txn) orphanedIds.push(ii.id);
    }
  }

  let cleanedImeis = 0;
  if (orphanedIds.length) {
    const r = await prisma.imeiInventory.updateMany({
      where: { id: { in: orphanedIds }, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id },
    });
    cleanedImeis = r.count;
  }

  // Step 2: Fix stock levels to match remaining valid IMEI records
  const stockCounts = await prisma.imeiInventory.groupBy({
    by: ['productId', 'warehouseId'],
    where: { isDeleted: false, status: 'IN_STOCK' },
    _count: { id: true },
  });

  for (const sc of stockCounts) {
    await prisma.stockLevel.updateMany({
      where: { productId: sc.productId, warehouseId: sc.warehouseId },
      data: { quantity: sc._count.id },
    });
  }

  ok(res, {
    cleanedImeis,
    message: `Cleaned ${cleanedImeis} orphaned IMEI records and recalculated stock levels`,
  });
}));


// ── List transactions by type (for Opening Stock history, etc.) ──────────────
router.get('/transactions', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  const { type, page = '1', limit = '100' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = {};
  if (type) where.type = type;
  const [items, total] = await prisma.$transaction([
    prisma.inventoryTransaction.findMany({
      where,
      include: {
        product:   { select: { id: true, ean: true, model: true, brand: true, imeiRequired: true } },
        vendor:    { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip, take: parseInt(limit),
    }),
    prisma.inventoryTransaction.count({ where }),
  ]);
  // For OPENING/STOCK_IN transactions, also find linked IMEIs
  const enriched = await Promise.all(items.map(async (t) => {
    let imeis: string[] = [];
    if (t.quantity > 0) {
      const imeiRecs = await prisma.imeiInventory.findMany({
        where: { stockInTxnId: t.id, isDeleted: false },
        select: { imei1: true },
      });
      imeis = imeiRecs.map(i => i.imei1);
    }
    return {
      id: t.id, type: t.type, quantity: t.quantity,
      productId: t.product.id, ean: t.product.ean,
      model: t.product.model, brand: t.product.brand,
      imeiRequired: t.product.imeiRequired,
      vendorId: t.vendorId, vendorName: t.vendor?.name ?? null,
      warehouseId: t.warehouseId, warehouseName: t.warehouse.name,
      unitCost: t.unitCost, remarks: t.remarks,
      createdAt: t.createdAt, imeis,
    };
  }));
  ok(res, { items: enriched, total, page: parseInt(page), limit: parseInt(limit) });
}));


// ── List transactions by type (for Opening Stock history, etc.) ──────────────
router.get('/transactions', authorize(PERMISSIONS.INVENTORY_READ), asyncHandler(async (req: Request, res: Response) => {
  const { type, page = '1', limit = '100' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = {};
  if (type) where.type = type;
  const [items, total] = await prisma.$transaction([
    prisma.inventoryTransaction.findMany({
      where, include: {
        product:   { select: { id: true, ean: true, model: true, brand: true, imeiRequired: true } },
        vendor:    { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip, take: parseInt(limit),
    }),
    prisma.inventoryTransaction.count({ where }),
  ]);
  const enriched = await Promise.all(items.map(async (t) => {
    let imeis: string[] = [];
    if (t.quantity > 0) {
      const recs = await prisma.imeiInventory.findMany({ where: { stockInTxnId: t.id, isDeleted: false }, select: { imei1: true } });
      imeis = recs.map(r => r.imei1);
    }
    return { id: t.id, type: t.type, quantity: t.quantity,
      productId: t.product.id, ean: t.product.ean, model: t.product.model, brand: t.product.brand, imeiRequired: t.product.imeiRequired,
      vendorId: t.vendorId, vendorName: t.vendor?.name ?? null,
      warehouseId: t.warehouseId, warehouseName: t.warehouse.name,
      unitCost: t.unitCost ? Number(t.unitCost) : null, remarks: t.remarks, createdAt: t.createdAt.toISOString(), imeis };
  }));
  ok(res, { items: enriched, total, page: parseInt(page), limit: parseInt(limit) });
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
