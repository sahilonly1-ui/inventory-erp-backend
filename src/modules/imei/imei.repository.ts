import { Prisma, ImeiStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';

export interface LockedImei {
  id: string;
  imei1: string;
  imei2: string | null;
  status: ImeiStatus;
  productId: string;
  warehouseId: string;
}

export const imeiRepository = {
  createReceived(
    tx: Prisma.TransactionClient,
    productId: string,
    warehouseId: string,
    imeis: { imei1: string; imei2?: string | null }[],
    createdBy: string,
  ) {
    return tx.imeiInventory.createMany({
      data: imeis.map((i) => ({
        productId,
        warehouseId,
        imei1: i.imei1,
        imei2: i.imei2 ?? null,
        status: ImeiStatus.IN_STOCK,
        createdBy,
      })),
    });
  },

  // Row-locks the given IMEIs FOR UPDATE so concurrent dispatches can't double-sell.
  lockByImei1(tx: Prisma.TransactionClient, imei1List: string[]) {
    return tx.$queryRaw<LockedImei[]>`
      SELECT "id", "imei1", "imei2", "status", "productId", "warehouseId"
      FROM imei_inventory
      WHERE "imei1" IN (${Prisma.join(imei1List)}) AND "isDeleted" = false
      FOR UPDATE`;
  },

  setStatus(tx: Prisma.TransactionClient, ids: string[], status: ImeiStatus, updatedBy: string) {
    return tx.imeiInventory.updateMany({ where: { id: { in: ids } }, data: { status, updatedBy } });
  },

  moveWarehouse(tx: Prisma.TransactionClient, ids: string[], toWarehouseId: string, updatedBy: string) {
    return tx.imeiInventory.updateMany({
      where: { id: { in: ids } },
      data: { warehouseId: toWarehouseId, updatedBy },
    });
  },

  countInStock(tx: Prisma.TransactionClient, productId: string, warehouseId: string) {
    return tx.imeiInventory.count({
      where: { productId, warehouseId, status: ImeiStatus.IN_STOCK, isDeleted: false },
    });
  },

  findByImei1(imei1: string) {
    return prisma.imeiInventory.findFirst({
      where: { imei1, isDeleted: false },
      include: {
        product: { select: { id: true, ean: true, sku: true, model: true, brand: true } },
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  },

  list(params: {
    status?: ImeiStatus; productId?: string; warehouseId?: string; search?: string;
    skip: number; take: number;
  }) {
    const where: Prisma.ImeiInventoryWhereInput = {
      isDeleted: false,
      ...(params.status ? { status: params.status } : {}),
      ...(params.productId ? { productId: params.productId } : {}),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.search
        ? { OR: [{ imei1: { contains: params.search } }, { imei2: { contains: params.search } }] }
        : {}),
    };
    return prisma.$transaction([
      prisma.imeiInventory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.imeiInventory.count({ where }),
    ]);
  },
};
