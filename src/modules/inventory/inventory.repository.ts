import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import { InsufficientStockError } from '../../common/errors';
import { LedgerMovementParams } from './inventory.dto';

export const inventoryRepository = {
  // Atomically apply a signed delta to a (product, warehouse) stock level.
  // Strategy: ensure the row exists, take a ROW LOCK (FOR UPDATE), compute the
  // new value, reject negatives with a clean error, then write. The DB CHECK
  // constraint is the final backstop. Read-modify-write is safe because the
  // row is locked for the duration of the transaction.
  async lockAndApplyDelta(
    tx: Prisma.TransactionClient,
    productId: string,
    warehouseId: string,
    delta: number,
  ): Promise<number> {
    await tx.$executeRaw`
      INSERT INTO stock_levels ("id", "productId", "warehouseId", "quantity", "updatedAt")
      VALUES (${randomUUID()}, ${productId}, ${warehouseId}, 0, now())
      ON CONFLICT ("productId", "warehouseId") DO NOTHING`;

    const rows = await tx.$queryRaw<{ id: string; quantity: number }[]>`
      SELECT "id", "quantity" FROM stock_levels
      WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
      FOR UPDATE`;

    const row = rows[0];
    const next = row.quantity + delta;
    if (next < 0) throw new InsufficientStockError(productId, warehouseId, row.quantity, delta);

    await tx.$executeRaw`
      UPDATE stock_levels SET "quantity" = ${next}, "updatedAt" = now()
      WHERE "id" = ${row.id}`;

    return next;
  },

  recordTransaction(tx: Prisma.TransactionClient, params: LedgerMovementParams & { createdBy: string }) {
    const data: Prisma.InventoryTransactionUncheckedCreateInput = {
      productId: params.productId,
      warehouseId: params.warehouseId,
      type: params.type,
      quantity: params.signedQty,
      unitCost: params.unitCost ?? null,
      vendorId: params.vendorId ?? null,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      remarks: params.remarks ?? null,
      createdBy: params.createdBy,
      // Only set when supplied, so live entries keep the DB default of now().
      ...(params.occurredAt ? { createdAt: params.occurredAt } : {}),
    };
    return tx.inventoryTransaction.create({ data });
  },

  async ledgerSum(
    client: Prisma.TransactionClient,
    productId: string,
    warehouseId: string,
  ): Promise<number> {
    const r = await client.inventoryTransaction.aggregate({
      where: { productId, warehouseId },
      _sum: { quantity: true },
    });
    return r._sum.quantity ?? 0;
  },

  getStockLevel(productId: string, warehouseId: string) {
    return prisma.stockLevel.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
  },

  listStockLevels(params: { productId?: string; warehouseId?: string; skip: number; take: number }) {
    const where: Prisma.StockLevelWhereInput = {
      ...(params.productId ? { productId: params.productId } : {}),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    };
    return prisma.$transaction([
      prisma.stockLevel.findMany({
        where,
        include: { warehouse: { select: { name: true, code: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.stockLevel.count({ where }),
    ]);
  },

  listLedger(params: {
    productId?: string;
    warehouseId?: string;
    type?: Prisma.InventoryTransactionWhereInput['type'];
    from?: Date;
    to?: Date;
    skip: number;
    take: number;
  }) {
    const where: Prisma.InventoryTransactionWhereInput = {
      ...(params.productId ? { productId: params.productId } : {}),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };
    return prisma.$transaction([
      prisma.inventoryTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.inventoryTransaction.count({ where }),
    ]);
  },

  findProductByEan(ean: string) {
    return prisma.product.findFirst({ where: { ean, isDeleted: false } });
  },

  findActiveProduct(id: string) {
    return prisma.product.findFirst({ where: { id, isDeleted: false } });
  },

  stockByProduct(productId: string) {
    return prisma.stockLevel.findMany({
      where: { productId },
      include: { warehouse: { select: { id: true, name: true, code: true } } },
    });
  },
};
