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

  const okCount  = results.filter(r => r.status === 'ok').length;
  const nf  = results.filter(r => r.status === 'not_found').length;
  const err = results.filter(r => r.status === 'error').length;
  ok(res, { processed: rows.length, ok: okCount, not_found: nf, errors: err, results });
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

// Recover swipe/activation history that an entry edit wiped.
//
// Editing a stock-in entry used to soft-delete its IMEI rows and re-create them
// blank. The old rows still hold the flags and dates, so the state can be
// lifted back onto the live rows. Defaults to a dry run so the result can be
// reviewed before anything is written.
router.post('/restore-activations', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const since = req.body?.since ? new Date(String(req.body.since)) : undefined;

  const deleted = await prisma.imeiInventory.findMany({
    where: {
      isDeleted: true,
      OR: [{ activated: true }, { swiped: true }],
      ...(since ? { deletedAt: { gte: since } } : {}),
    },
    select: { imei1: true, swiped: true, swipedAt: true, activated: true, activatedAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });

  // Several deleted generations can exist for one IMEI; the newest wins.
  const best = new Map<string, typeof deleted[number]>();
  for (const d of deleted) if (!best.has(d.imei1)) best.set(d.imei1, d);
  const imeis = [...best.keys()];
  if (!imeis.length) {
    ok(res, { dryRun, candidates: 0, restored: 0, sample: [] });
    return;
  }

  const live = await prisma.imeiInventory.findMany({
    where: { isDeleted: false, imei1: { in: imeis } },
    select: { id: true, imei1: true, swiped: true, activated: true },
  });

  // Only ever fill in blanks — never overwrite a flag someone has since set.
  const updates: { id: string; imei: string; data: Record<string, unknown> }[] = [];
  for (const l of live) {
    const d = best.get(l.imei1)!;
    const data: Record<string, unknown> = {};
    if (d.activated && !l.activated) { data.activated = true; data.activatedAt = d.activatedAt; }
    if (d.swiped && !l.swiped) { data.swiped = true; data.swipedAt = d.swipedAt; }
    if (Object.keys(data).length) updates.push({ id: l.id, imei: l.imei1, data });
  }

  if (!dryRun) {
    for (const u of updates) {
      await prisma.imeiInventory.update({ where: { id: u.id }, data: u.data });
    }
  }

  ok(res, {
    dryRun,
    candidates: best.size,
    liveMatched: live.length,
    restored: updates.length,
    sample: updates.slice(0, 25).map(u => ({ imei: u.imei, ...u.data })),
  });
}));

router.get('/', authorize(PERMISSIONS.IMEI_READ), validate(imeiQuerySchema, 'query'), imeiController.list);
// Bring back IMEI/serial records that a deleted Stock Out entry wrongly
// removed from the tracker.
//
// Deleting a dispatch used to soft-delete its units instead of returning them
// to stock, so the serials vanished even though the goods were back on the
// shelf. This restores those rows. A unit is only restored when no live record
// already holds the same IMEI, so it can never create a duplicate.
// Remove specific units by IMEI, and correct the stock level to match.
//
// The counterpart to the diagnostic above: once the units that should not be
// in stock have been identified, this takes them back out. Soft-delete keeps
// the history and frees the serial for re-entry.
router.post('/remove-units', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun !== false;
  const imeis: string[] = Array.isArray(req.body?.imeis) ? req.body.imeis.filter(Boolean) : [];
  if (!imeis.length) throw new BadRequestError('imeis is required');

  const units = await prisma.imeiInventory.findMany({
    where: { imei1: { in: imeis }, isDeleted: false },
    select: { id: true, imei1: true, productId: true, warehouseId: true, status: true },
  });

  const missing = imeis.filter(i => !units.some(u => u.imei1 === i));

  // Removing a unit that counts towards stock must reduce that stock, or the
  // level and the units disagree again.
  const inStock = units.filter(u => u.status === 'IN_STOCK');
  const decrements = new Map<string, number>();
  for (const u of inStock) {
    const key = `${u.productId}::${u.warehouseId}`;
    decrements.set(key, (decrements.get(key) ?? 0) + 1);
  }

  if (!dryRun && units.length) {
    await prisma.$transaction(async tx => {
      await tx.imeiInventory.updateMany({
        where: { id: { in: units.map(u => u.id) } },
        data: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id },
      });
      for (const [key, n] of decrements) {
        const [productId, warehouseId] = key.split('::');
        const level = await tx.stockLevel.findFirst({ where: { productId, warehouseId } });
        if (level) {
          await tx.stockLevel.update({
            where: { id: level.id },
            data: { quantity: Math.max(0, level.quantity - n) },
          });
        }
      }
    });
  }

  ok(res, {
    dryRun,
    removed: dryRun ? 0 : units.length,
    found: units.length,
    notFound: missing,
    stockReduced: [...decrements.entries()].map(([k, n]) => ({ key: k, by: n })),
  });
}));

// Review the units brought back by a restore run.
//
// A restore returns every soft-deleted unit it can find. That is right for
// units lost to a bug, but wrong for units that were deleted deliberately —
// and the two are indistinguishable to the restore itself. This lists what a
// run put back so the deliberate ones can be identified and removed again.
//
// Read-only. Grouped by product, with whether the unit has a transaction
// behind it, since a unit with no movement history is usually one that should
// not be in stock.
router.get('/restored-units', authorize(PERMISSIONS.IMEI_READ), asyncHandler(async (req: Request, res: Response) => {
  const onDate = req.query.date ? String(req.query.date) : null;
  const from = onDate ? new Date(`${onDate}T00:00:00.000Z`) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to   = onDate ? new Date(`${onDate}T23:59:59.999Z`) : new Date();

  const units = await prisma.imeiInventory.findMany({
    where: { isDeleted: false, updatedAt: { gte: from, lte: to } },
    select: {
      id: true, imei1: true, status: true, createdAt: true, updatedAt: true,
      stockInTxnId: true, stockOutTxnId: true,
      product: { select: { id: true, ean: true, model: true } },
      supplier: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  // A unit whose linked transaction no longer exists is orphaned — it counts
  // towards stock while nothing explains how it got there.
  const txnIds = [...new Set(units.map(u => u.stockInTxnId).filter(Boolean))] as string[];
  const liveTxns = txnIds.length
    ? await prisma.inventoryTransaction.findMany({ where: { id: { in: txnIds } }, select: { id: true } })
    : [];
  const liveTxnIds = new Set(liveTxns.map(t => t.id));

  const grouped = new Map<string, any>();
  for (const u of units) {
    const key = u.product.id;
    if (!grouped.has(key)) {
      grouped.set(key, {
        ean: u.product.ean,
        model: u.product.model,
        units: [] as any[],
      });
    }
    grouped.get(key).units.push({
      imei: u.imei1,
      status: u.status,
      supplier: u.supplier?.name ?? null,
      stockInDate: u.createdAt.toISOString().slice(0, 10),
      touchedOn: u.updatedAt.toISOString().slice(0, 10),
      hasTransaction: u.stockInTxnId ? liveTxnIds.has(u.stockInTxnId) : false,
    });
  }

  const products = [...grouped.values()].map(g => ({
    ...g,
    total: g.units.length,
    orphaned: g.units.filter((x: any) => !x.hasTransaction).length,
  })).sort((a, b) => b.orphaned - a.orphaned);

  ok(res, {
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    unitsExamined: units.length,
    orphanedTotal: products.reduce((n, p) => n + p.orphaned, 0),
    products,
  });
}));

router.post('/restore-deleted', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const since = req.body?.since ? new Date(String(req.body.since)) : undefined;

  const deleted = await prisma.imeiInventory.findMany({
    where: { isDeleted: true, ...(since ? { deletedAt: { gte: since } } : {}) },
    select: { id: true, imei1: true, status: true, deletedAt: true, product: { select: { model: true } } },
    orderBy: { deletedAt: 'desc' },
    take: 5000,
  });
  if (!deleted.length) { ok(res, { dryRun, candidates: 0, restorable: 0, restored: 0, sample: [] }); return; }

  // Skip any IMEI that already exists as a live record.
  const live = await prisma.imeiInventory.findMany({
    where: { isDeleted: false, imei1: { in: deleted.map(d => d.imei1) } },
    select: { imei1: true },
  });
  const taken = new Set(live.map(l => l.imei1));

  // One deleted generation per IMEI — the newest.
  const seen = new Set<string>();
  const plan: typeof deleted = [];
  for (const d of deleted) {
    if (taken.has(d.imei1) || seen.has(d.imei1)) continue;
    seen.add(d.imei1);
    plan.push(d);
  }

  if (!dryRun && plan.length) {
    await prisma.imeiInventory.updateMany({
      where: { id: { in: plan.map(p => p.id) } },
      // Back on the shelf, and visible in the tracker again.
      data: { isDeleted: false, deletedAt: null, deletedBy: null, status: 'IN_STOCK', updatedBy: req.user!.id },
    });
  }

  ok(res, {
    dryRun,
    candidates: deleted.length,
    restorable: plan.length,
    restored: dryRun ? 0 : plan.length,
    skipped: deleted.length - plan.length,
    sample: plan.slice(0, 25).map(p => ({ imei: p.imei1, product: p.product?.model ?? '', deletedAt: p.deletedAt })),
  });
}));

// Brands that actually have units in the tracker. The full Product Master list
// runs to dozens of brands that carry no IMEI or serial at all, which makes the
// filter useless to scan. Declared before '/:imei' so the literal path wins.
router.get('/brands', authorize(PERMISSIONS.IMEI_READ), asyncHandler(async (_req, res) => {
  const rows = await prisma.imeiInventory.findMany({
    where: { isDeleted: false },
    select: { product: { select: { brand: true } } },
    distinct: ['productId'],
  });
  const seen: string[] = [];
  for (const r of rows) {
    const b = r.product?.brand;
    if (b && !seen.includes(b)) seen.push(b);
  }
  seen.sort((a, b) => a.localeCompare(b));
  const brands = seen;
  ok(res, brands);
}));

router.get('/:imei', authorize(PERMISSIONS.IMEI_READ), validate(imeiParamSchema, 'params'), imeiController.lookup);

export default router;
