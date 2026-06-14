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
  const imeiCount = imeiRequired ? await imeiRepository.countInStock(tx, productId, warehouseId) : null;

  const consistent = ledger === level && (imeiCount === null || imeiCount === level);

  if (!consistent) {
    const detail = { productId, warehouseId, ledger, level, imeiCount };
    if (opts.strict) throw new ReconciliationError(detail);

    await writeAudit(tx, {
      action: 'UPDATE',
      entityName: 'reconciliation',
      entityId: `${productId}:${warehouseId}`,
      newValue: { ...detail, status: 'MISMATCH' },
    });
    await tx.notification.create({
      data: {
        type: 'SYSTEM',
        title: 'Stock reconciliation mismatch',
        message: `Product ${productId} @ ${warehouseId}: ledger=${ledger}, level=${level}, imei=${imeiCount}`,
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
