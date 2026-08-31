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
// Attach units to a dispatch that was recorded without their codes.
//
// A Stock Out entered as a plain quantity moves the stock but leaves the units
// sitting IN_STOCK, so the tracker keeps showing goods that have already left
// and the count no longer matches the units. Dispatching them again would move
// the stock a second time, which is wrong — the movement already happened.
//
// This marks the named units SOLD against that existing transaction, without
// creating another movement.
router.post('/attach-to-dispatch', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun !== false;
  const txnId = String(req.body?.txnId ?? '').trim();
  const imeis: string[] = Array.isArray(req.body?.imeis) ? req.body.imeis.filter(Boolean) : [];
  if (!txnId) throw new BadRequestError('txnId is required');
  if (!imeis.length) throw new BadRequestError('imeis is required');

  const txn = await prisma.inventoryTransaction.findUnique({
    where: { id: txnId },
    select: { id: true, productId: true, warehouseId: true, quantity: true, createdAt: true },
  });
  if (!txn) throw new NotFoundError('Transaction not found');

  // Inbound entries need the opposite treatment: the units were never created,
  // so there is nothing to mark SOLD. A quantity-only receipt (an Opening Stock
  // or Stock In saved without codes) leaves stock on the books with no unit
  // records, which is why such a product shows fewer tracked units than stock.
  const inbound = txn.quantity > 0;

  // Case-insensitive: serials are often written down in a different case than
  // they were scanned.
  const all = await prisma.imeiInventory.findMany({
    where: { productId: txn.productId, isDeleted: false },
    select: { id: true, imei1: true, status: true },
  });
  const wanted = imeis.map(i => i.trim().toLowerCase());
  const matched = all.filter(u => wanted.includes(u.imei1.toLowerCase()));
  const notFound = imeis.filter(i => !matched.some(m => m.imei1.toLowerCase() === i.trim().toLowerCase()));

  if (matched.length > Math.abs(txn.quantity)) {
    throw new BadRequestError(
      `That dispatch moved ${Math.abs(txn.quantity)} unit(s), but ${matched.length} were named. ` +
      `Attaching more units than the movement covers would misstate the stock.`,
    );
  }

  // For an inbound entry the serials are expected NOT to exist yet — that is
  // the whole problem being repaired — so anything already on record is a
  // conflict rather than a match.
  const existingCount = await prisma.imeiInventory.count({
    where: { productId: txn.productId, isDeleted: false, stockInTxnId: txn.id },
  });

  if (inbound) {
    if (matched.length) {
      throw new BadRequestError(
        `Already on record: ${matched.map(m => m.imei1).join(', ')}. ` +
        `A receipt cannot create units that already exist.`,
      );
    }
    if (existingCount + imeis.length > txn.quantity) {
      throw new BadRequestError(
        `That entry received ${txn.quantity} unit(s) and ${existingCount} already have codes. ` +
        `Adding ${imeis.length} more would exceed what was received.`,
      );
    }
    if (!dryRun) {
      await prisma.imeiInventory.createMany({
        data: imeis.map(i => ({
          productId: txn.productId,
          warehouseId: txn.warehouseId,
          imei1: i.trim(),
          imeiType: 'NIL',
          status: 'IN_STOCK' as const,
          stockInTxnId: txn.id,
          // Dated to the receipt, not to this repair.
          createdAt: txn.createdAt,
          createdBy: req.user!.id,
        })),
        skipDuplicates: true,
      });
    }
    ok(res, {
      dryRun,
      direction: 'received',
      entryDate: txn.createdAt.toISOString().slice(0, 10),
      entryQuantity: txn.quantity,
      alreadyCoded: existingCount,
      attached: dryRun ? 0 : imeis.length,
      serials: imeis,
    });
    return;
  }

  if (!dryRun && matched.length) {
    await prisma.imeiInventory.updateMany({
      where: { id: { in: matched.map(m => m.id) } },
      data: { status: 'SOLD', stockOutTxnId: txn.id, updatedBy: req.user!.id },
    });
  }

  ok(res, {
    dryRun,
    direction: 'dispatched',
    dispatchDate: txn.createdAt.toISOString().slice(0, 10),
    dispatchQuantity: Math.abs(txn.quantity),
    attached: dryRun ? 0 : matched.length,
    matched: matched.map(m => ({ imei: m.imei1, wasStatus: m.status })),
    notFound,
  });
}));

// Bring the stock level back in line with the units on record.
//
// Dispatch refuses to run when a product holds more tracked units than its
// stock level claims, which is a genuine inconsistency — but one the operator
// cannot fix from any screen. It happens when units are added or restored
// without the counter moving with them.
//
// The units win: each is a real record with its own IMEI and history, whereas
// the level is only a running count. This sets the level to the number of
// units actually in stock. Dry run by default.
router.post('/reconcile-levels', authorize(PERMISSIONS.INVENTORY_ADJUST), asyncHandler(async (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun !== false;
  const ean = req.body?.ean ? String(req.body.ean).trim() : null;

  const products = await prisma.product.findMany({
    where: ean ? { ean } : {},
    select: { id: true, ean: true, model: true },
  });
  if (!products.length) throw new NotFoundError('Product not found');

  const productIds = products.map(p => p.id);
  const byId = new Map(products.map(p => [p.id, p]));

  const levels = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds } },
    select: { id: true, productId: true, warehouseId: true, quantity: true },
  });

  const changes: any[] = [];
  for (const l of levels) {
    const unitCount = await prisma.imeiInventory.count({
      where: { productId: l.productId, warehouseId: l.warehouseId, isDeleted: false, status: 'IN_STOCK' },
    });
    // Products with no tracked units at all are quantity-only (accessories);
    // their level is the only record there is, so leave it alone.
    if (unitCount === 0) continue;
    if (unitCount === l.quantity) continue;

    changes.push({
      ean: byId.get(l.productId)?.ean,
      model: byId.get(l.productId)?.model,
      warehouseId: l.warehouseId,
      levelWas: l.quantity,
      unitsInStock: unitCount,
    });

    if (!dryRun) {
      await prisma.stockLevel.update({ where: { id: l.id }, data: { quantity: unitCount } });
    }
  }

  ok(res, {
    dryRun,
    scope: ean ?? 'all products',
    levelsChecked: levels.length,
    corrected: dryRun ? 0 : changes.length,
    mismatches: changes.length,
    changes: changes.slice(0, 100),
  });
}));

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

      // Recompute the level from the units that remain rather than subtracting.
      // Subtracting assumes the level and the units agreed to begin with, and
      // the whole reason for removing units is usually that they did not.
      for (const key of decrements.keys()) {
        const [productId, warehouseId] = key.split('::');
        const remaining = await tx.imeiInventory.count({
          where: { productId, warehouseId, isDeleted: false, status: 'IN_STOCK' },
        });
        const level = await tx.stockLevel.findFirst({ where: { productId, warehouseId } });
        if (level) {
          await tx.stockLevel.update({ where: { id: level.id }, data: { quantity: remaining } });
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

// Restore specific units by name.
//
// The blanket restore deliberately skips units whose Stock In entry is gone,
// because it cannot tell a unit lost to a bug from one deleted on purpose.
// Naming a unit explicitly supplies exactly that judgement, so this restores
// what it is told to and nothing else.
//
// Each unit returns to the status it held when deleted — a unit that was SOLD
// comes back SOLD, not as stock. Forcing everything to IN_STOCK is what put
// phantom stock on the books last time.
router.post('/restore-units', authorize(PERMISSIONS.IMEI_MANAGE), asyncHandler(async (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun !== false;
  const codes: string[] = Array.isArray(req.body?.imeis) ? req.body.imeis.filter(Boolean) : [];
  if (!codes.length) throw new BadRequestError('imeis is required');

  const deleted = await prisma.imeiInventory.findMany({
    where: { isDeleted: true, OR: codes.map(c => ({ imei1: { equals: String(c).trim(), mode: 'insensitive' as const } })) },
    select: {
      id: true, imei1: true, status: true, productId: true, warehouseId: true,
      product: { select: { model: true } },
    },
    orderBy: { deletedAt: 'desc' },
  });

  // Never create a second live row for the same serial.
  const live = await prisma.imeiInventory.findMany({
    where: { isDeleted: false, OR: deleted.map(d => ({ imei1: { equals: d.imei1, mode: 'insensitive' as const } })) },
    select: { imei1: true },
  });
  const taken = new Set(live.map(l => l.imei1.toLowerCase()));

  const seen = new Set<string>();
  const plan = deleted.filter(d => {
    const k = d.imei1.toLowerCase();
    if (taken.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const notFound = codes.filter(c => !plan.some(p => p.imei1.toLowerCase() === String(c).trim().toLowerCase()));

  if (!dryRun && plan.length) {
    await prisma.$transaction(async tx => {
      await tx.imeiInventory.updateMany({
        where: { id: { in: plan.map(p => p.id) } },
        data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: req.user!.id },
      });

      // Recompute each affected level from the units, so restoring cannot leave
      // the count and the units disagreeing.
      const keys = [...new Set(plan.map(p => `${p.productId}::${p.warehouseId}`))];
      for (const key of keys) {
        const [productId, warehouseId] = key.split('::');
        const n = await tx.imeiInventory.count({
          where: { productId, warehouseId, isDeleted: false, status: 'IN_STOCK' },
        });
        const level = await tx.stockLevel.findFirst({ where: { productId, warehouseId } });
        if (level) await tx.stockLevel.update({ where: { id: level.id }, data: { quantity: n } });
      }
    });
  }

  ok(res, {
    dryRun,
    restored: dryRun ? 0 : plan.length,
    willRestore: plan.map(p => ({ imei: p.imei1, product: p.product?.model, returningAs: p.status })),
    notFound,
  });
}));

// Find a serial or IMEI wherever it exists, including places a normal lookup
// does not reach.
//
// A plain lookup returns 404 for anything not a live unit, which cannot
// distinguish "never entered" from "entered and later deleted" or "recorded
// only as text in an entry's notes". Those need different fixes, so the
// difference matters.
router.post('/trace', authorize(PERMISSIONS.IMEI_READ), asyncHandler(async (req: Request, res: Response) => {
  const codes: string[] = Array.isArray(req.body?.imeis) ? req.body.imeis.filter(Boolean) : [];
  if (!codes.length) throw new BadRequestError('imeis is required');

  const results = [];
  for (const raw of codes) {
    const code = String(raw).trim();

    // Case-insensitive: serials get written down in a different case than scanned.
    const units = await prisma.imeiInventory.findMany({
      where: { imei1: { equals: code, mode: 'insensitive' } },
      select: {
        id: true, imei1: true, status: true, isDeleted: true, deletedAt: true,
        createdAt: true, stockInTxnId: true, stockOutTxnId: true,
        product: { select: { ean: true, model: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Serials that older code wrote into the entry notes instead of storing as
    // units — the record exists, just not where anything can use it.
    const inRemarks = await prisma.inventoryTransaction.findMany({
      where: { remarks: { contains: code, mode: 'insensitive' } },
      select: { id: true, quantity: true, createdAt: true, remarks: true, product: { select: { ean: true, model: true } } },
      take: 5,
    });

    let verdict: string;
    if (units.some(u => !u.isDeleted)) verdict = 'in tracker';
    else if (units.length) verdict = 'deleted from tracker';
    else if (inRemarks.length) verdict = 'only in entry notes — never stored as a unit';
    else verdict = 'not found anywhere';

    results.push({
      code,
      verdict,
      units: units.map(u => ({
        product: u.product?.model, ean: u.product?.ean,
        status: u.status, isDeleted: u.isDeleted,
        stockInDate: u.createdAt.toISOString().slice(0, 10),
        deletedAt: u.deletedAt ? u.deletedAt.toISOString().slice(0, 10) : null,
        hasStockInLink: !!u.stockInTxnId,
        hasDispatchLink: !!u.stockOutTxnId,
      })),
      foundInEntries: inRemarks.map(t => ({
        txnId: t.id,
        direction: t.quantity > 0 ? 'received' : 'dispatched',
        date: t.createdAt.toISOString().slice(0, 10),
        product: t.product?.model,
      })),
    });
  }

  ok(res, { checked: codes.length, results });
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
    select: {
      id: true, imei1: true, status: true, deletedAt: true,
      stockInTxnId: true,
      product: { select: { model: true } },
    },
    orderBy: { deletedAt: 'desc' },
    take: 5000,
  });
  if (!deleted.length) { ok(res, { dryRun, candidates: 0, restorable: 0, restored: 0, skippedNoEntry: 0, sample: [] }); return; }

  // Skip any IMEI that already exists as a live record.
  const live = await prisma.imeiInventory.findMany({
    where: { isDeleted: false, imei1: { in: deleted.map(d => d.imei1) } },
    select: { imei1: true },
  });
  const taken = new Set(live.map(l => l.imei1));

  // Only restore a unit whose Stock In entry still exists.
  //
  // Restoring everything soft-deleted cannot tell a unit lost to a bug from one
  // the operator deleted on purpose, and it brought back units whose entry had
  // been removed — they counted as stock with nothing explaining where they
  // came from, and made those products undispatchable. A surviving transaction
  // is the evidence that the unit belongs in stock.
  const txnIds = [...new Set(deleted.map(d => d.stockInTxnId).filter(Boolean))] as string[];
  const liveTxns = txnIds.length
    ? await prisma.inventoryTransaction.findMany({ where: { id: { in: txnIds } }, select: { id: true } })
    : [];
  const liveTxnIds = new Set(liveTxns.map(t => t.id));

  // One deleted generation per IMEI — the newest.
  const seen = new Set<string>();
  const plan: typeof deleted = [];
  let skippedNoEntry = 0;
  for (const d of deleted) {
    if (taken.has(d.imei1) || seen.has(d.imei1)) continue;
    seen.add(d.imei1);
    if (!d.stockInTxnId || !liveTxnIds.has(d.stockInTxnId)) { skippedNoEntry++; continue; }
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
    // Units whose Stock In entry no longer exists are left alone on purpose.
    skippedNoEntry,
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
