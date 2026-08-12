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
  async createReceived(
    tx: Prisma.TransactionClient,
    productId: string,
    warehouseId: string,
    imeis: { imei1: string; imei2?: string | null; imeiType?: string }[],
    createdBy: string,
    vendorId?: string,
    stockInTxnId?: string,
  ) {
    // Editing a stock-in entry soft-deletes its IMEI rows and re-creates them.
    // Swipe/activation state lives on those rows, so without carrying it over
    // an unrelated edit silently wipes months of activation history. Look up
    // the most recent soft-deleted row per IMEI and restore its flags.
    const prior = await tx.imeiInventory.findMany({
      where: { imei1: { in: imeis.map(i => i.imei1) }, isDeleted: true },
      select: { imei1: true, swiped: true, swipedAt: true, activated: true, activatedAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const priorByImei = new Map<string, typeof prior[number]>();
    for (const p of prior) if (!priorByImei.has(p.imei1)) priorByImei.set(p.imei1, p);

    return tx.imeiInventory.createMany({
      data: imeis.map((i) => {
        const p = priorByImei.get(i.imei1);
        return {
          productId,
          warehouseId,
          imei1: i.imei1,
          imei2: i.imei2 ?? null,
          imeiType: i.imeiType ?? 'NIL',
          status: ImeiStatus.IN_STOCK,
          supplierId: vendorId ?? null,
          stockInTxnId: stockInTxnId ?? null,
          swiped: p?.swiped ?? false,
          swipedAt: p?.swipedAt ?? null,
          activated: p?.activated ?? false,
          activatedAt: p?.activatedAt ?? null,
          createdBy,
        };
      }),
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
    swiped?: boolean; activated?: boolean; imeiType?: string; brand?: string;
    skip: number; take: number;
  }) {
    const where: Prisma.ImeiInventoryWhereInput = {
      isDeleted: false,
      ...(params.status    ? { status:    params.status    } : {}),
      ...(params.imeiType  ? { imeiType:  params.imeiType  } : {}),
      ...(params.swiped    !== undefined ? { swiped:    params.swiped    } : {}),
      ...(params.activated !== undefined ? { activated: params.activated } : {}),
      ...(params.productId ? { productId: params.productId } : {}),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.brand ? { product: { brand: { equals: params.brand, mode: 'insensitive' } } } : {}),
      ...(params.search ? (() => {
        const words = params.search.trim().split(/\s+/).filter(Boolean);
        if (words.length <= 1) {
          return { OR: [
            { imei1: { contains: params.search } },
            { imei2: { contains: params.search } },
            { product: { ean: { contains: params.search } } },
            { product: { model: { contains: params.search, mode: 'insensitive' } } },
            { product: { brand: { contains: params.search, mode: 'insensitive' } } },
          ]};
        }
        // Multi-word: product model must contain ALL words
        return { AND: words.map((w: string) => ({ OR: [
          { imei1: { contains: w } },
          { imei2: { contains: w } },
          { product: { model: { contains: w, mode: 'insensitive' } } },
          { product: { brand: { contains: w, mode: 'insensitive' } } },
        ]}))};
      })() : {}),
      ...(params.imeiType ? { imeiType: params.imeiType } : {}),
      ...(params.swiped !== undefined ? { swiped: params.swiped === 'true' } : {}),
    };
    return prisma.$transaction([
      prisma.imeiInventory.findMany({
        where,
        include: {
          product: { select: { ean: true, model: true, brand: true, categoryId: true } },
          warehouse: { select: { name: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.imeiInventory.count({ where }),
    ]);
  },
};
