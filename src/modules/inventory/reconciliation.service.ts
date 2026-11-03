import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ReconciliationError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { inventoryRepository } from './inventory.repository';
import { imeiRepository } from '../imei/imei.repository';

export interface ReconcileResult {
  productId: string;
  warehouseId: string;
  ledger: number;
  level: number;
  imeiCount: number | null;
  consistent: boolean;
}

// Compares the three quantities that MUST agree:
//   ledger sum  ==  StockLevel cache  ==  in-stock IMEI count (for IMEI products)
// strict=true  -> throws (rolls back the movement) — used inside IMEI writes.
// strict=false -> records an audit alert + notification — used by the scheduled
//                 / on-demand reconciliation sweep.
export type StockSnapshot = { ledger: number; level: number; imeiCount: number };

/** The three numbers before a movement, so a check afterwards can tell what the movement itself changed. */
export async function snapshotTx(tx: Prisma.TransactionClient, productId: string, warehouseId: string): Promise<StockSnapshot> {
  const ledger = await inventoryRepository.ledgerSum(tx, productId, warehouseId);
  const levelRow = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });
  const imeiCount = await imeiRepository.countInStock(tx, productId, warehouseId);
  return { ledger, level: levelRow?.quantity ?? 0, imeiCount: imeiCount ?? 0 };
}

export async function assertConsistentTx(
  tx: Prisma.TransactionClient,
  productId: string,
  warehouseId: string,
  imeiRequired: boolean,
  opts: { strict: boolean; before?: StockSnapshot },
): Promise<ReconcileResult> {
  const ledger = await inventoryRepository.ledgerSum(tx, productId, warehouseId);
  const levelRow = await tx.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
  });
  const level = levelRow?.quantity ?? 0;
  // Always count the units that are actually on record — the imeiRequired flag
  // in Product Master is unreliable (phones often have it false), so gating
  // the count on it produces null and a null-pointer crash when units exist.
  const imeiCount = await imeiRepository.countInStock(tx, productId, warehouseId);

  // The ledger and the stock level must always agree exactly — a difference
  // there is a real accounting bug.
  const ledgerOk = ledger === level;

  // Tracked units are a different matter. A product's stock is often part
  // tracked and part not: accessories and older receipts were recorded as a
  // plain quantity with no unit records, and serials only started being stored
  // as units recently. Demanding imeiCount === level therefore blocked
  // perfectly valid entries — adding five serialised TVs to a product that
  // already held five untracked ones failed, even though nothing was wrong.
  //
  // The real invariant is that there can never be MORE tracked units than
  // stock. Fewer is expected, and is surfaced as a notification rather than
  // stopping the operator mid-entry.
  const imeiOverflow = imeiCount !== null && imeiCount > level;
  const imeiUnderCount = imeiCount !== null && imeiCount < level;

  const consistent = ledgerOk && !imeiOverflow && !imeiUnderCount;
  let blocking = !ledgerOk || imeiOverflow;
  // With a before-snapshot, only block what THIS movement made worse. A gap that
  // already existed (e.g. units left marked in stock after an untracked sale)
  // must not stop unrelated, correct entries — it is reported as an alert instead.
  if (opts.before) {
    const b = opts.before;
    const overflowBefore = Math.max(0, b.imeiCount - b.level);
    const overflowNow = Math.max(0, (imeiCount ?? 0) - level);
    const ledgerGapBefore = Math.abs(b.ledger - b.level);
    const ledgerGapNow = Math.abs(ledger - level);
    blocking = overflowNow > overflowBefore || ledgerGapNow > ledgerGapBefore;
  }

  if (!consistent) {
    const detail = { productId, warehouseId, ledger, level, imeiCount };
    if (opts.strict && blocking) {
      const prod = await tx.product.findUnique({ where: { id: productId }, select: { model: true } }).catch(() => null);
      throw new ReconciliationError({ ...detail, model: prod?.model ?? null,
        reason: !ledgerOk ? `entries add up to ${ledger} but the stock count says ${level}`
                          : `${imeiCount} units are marked in stock but the stock count is ${level}` });
    }

    // Logging must never abort a valid movement. Wrap both writes so that a
    // schema mismatch, missing userId, or any other failure in the audit/
    // notification path does not roll back the stock transaction itself.
    try {
      await writeAudit(tx, {
        action: 'UPDATE',
        entityName: 'reconciliation',
        entityId: `${productId}:${warehouseId}`,
        newValue: { ...detail, status: imeiUnderCount && ledgerOk ? 'PARTIALLY_TRACKED' : 'MISMATCH' },
      });
    } catch (auditErr) {
      console.error('[reconciliation] audit write failed (movement still applied):', auditErr);
    }
    try {
      await tx.notification.create({
        data: {
          type: 'SYSTEM',
          title: imeiUnderCount && ledgerOk ? 'Stock partially tracked' : 'Stock reconciliation mismatch',
          message: imeiUnderCount && ledgerOk
            ? `Product ${productId} @ ${warehouseId}: ${imeiCount} of ${level} units have an IMEI or serial recorded.`
            : `Product ${productId} @ ${warehouseId}: ledger=${ledger}, level=${level}, imei=${imeiCount}`,
          meta: detail,
        },
      });
    } catch (notifErr) {
      console.error('[reconciliation] notification write failed (movement still applied):', notifErr);
    }
  }

  return { productId, warehouseId, ledger, level, imeiCount, consistent };
}

export const reconciliationService = {
  assertConsistentTx,

  async reconcileOne(productId: string, warehouseId: string): Promise<ReconcileResult> {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    return prisma.$transaction((tx) =>
      assertConsistentTx(tx, productId, warehouseId, product?.imeiRequired ?? false, { strict: false }),
    );
  },

  async reconcileBatch(filter: { productId?: string; warehouseId?: string; limit: number }) {
    const levels = await prisma.stockLevel.findMany({
      where: {
        ...(filter.productId ? { productId: filter.productId } : {}),
        ...(filter.warehouseId ? { warehouseId: filter.warehouseId } : {}),
      },
      include: { product: { select: { imeiRequired: true } } },
      take: filter.limit,
    });

    const results: ReconcileResult[] = [];
    for (const lvl of levels) {
      results.push(
        await prisma.$transaction((tx) =>
          assertConsistentTx(tx, lvl.productId, lvl.warehouseId, lvl.product.imeiRequired, { strict: false }),
        ),
      );
    }
    return { checked: results.length, mismatches: results.filter((r) => !r.consistent) };
  },
};
