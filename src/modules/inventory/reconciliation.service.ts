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
export async function assertConsistentTx(
  tx: Prisma.TransactionClient,
  productId: string,
  warehouseId: string,
  imeiRequired: boolean,
  opts: { strict: boolean },
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
  const blocking = !ledgerOk || imeiOverflow;

  if (!consistent) {
    const detail = { productId, warehouseId, ledger, level, imeiCount };
    if (opts.strict && blocking) throw new ReconciliationError(detail);

    await writeAudit(tx, {
      action: 'UPDATE',
      entityName: 'reconciliation',
      entityId: `${productId}:${warehouseId}`,
      newValue: { ...detail, status: imeiUnderCount && ledgerOk ? 'PARTIALLY_TRACKED' : 'MISMATCH' },
    });
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
