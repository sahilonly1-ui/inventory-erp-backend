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
    // One statement instead of three (the database is ~100 ms away per trip).
    // Postgres locks the row while it updates it, so concurrent movements still
    // queue up exactly as with SELECT ... FOR UPDATE.
    if (delta >= 0) {
      const rows = await tx.$queryRaw<{ quantity: number }[]>`
        INSERT INTO stock_levels ("id", "productId", "warehouseId", "quantity", "updatedAt")
        VALUES (${randomUUID()}, ${productId}, ${warehouseId}, ${delta}, now())
        ON CONFLICT ("productId", "warehouseId")
        DO UPDATE SET "quantity" = stock_levels."quantity" + EXCLUDED."quantity", "updatedAt" = now()
        RETURNING "quantity"`;
      return Number(rows[0].quantity);
    }
    const rows = await tx.$queryRaw<{ quantity: number }[]>`
      UPDATE stock_levels SET "quantity" = "quantity" + ${delta}, "updatedAt" = now()
      WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId} AND "quantity" + ${delta} >= 0
      RETURNING "quantity"`;
    if (rows.length) return Number(rows[0].quantity);
    // Not enough stock (or no stock row at all): read what there is for the message.
    const cur = await tx.$queryRaw<{ quantity: number }[]>`
      SELECT "quantity" FROM stock_levels WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}`;
    throw new InsufficientStockError(productId, warehouseId, Number(cur[0]?.quantity ?? 0), delta);
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
