import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

const PRODUCT_INCLUDE = {
  category: true,
  vendor: true,
  brandRef: true,
  stockLevels: { include: { warehouse: true } },
  attributes: true,
} as const;

export const productRepository = {
  findById(id: string) {
    return prisma.product.findFirst({
      where: { id, isDeleted: false },
      include: PRODUCT_INCLUDE,
    });
  },

  findByEan(ean: string) {
    return prisma.product.findFirst({ where: { ean, isDeleted: false } });
  },

  async list(params: {
    search?: string;
    brand?: string | string[];
    brandId?: string | string[];
    categoryId?: string | string[];
    vendorId?: string | string[];
    warehouseId?: string;
    imeiRequired?: boolean;
    status?: string | string[];
    costPriceMin?: number;
    costPriceMax?: number;
    sellingPriceMin?: number;
    sellingPriceMax?: number;
    createdFrom?: string;
    createdTo?: string;
    lowStock?: boolean;
    outOfStock?: boolean;
    skip: number;
    take: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }) {
    const toArray = (v: string | string[] | undefined) =>
      v ? (Array.isArray(v) ? v : [v]) : undefined;

    const brands = toArray(params.brand);
    const brandIds = toArray(params.brandId);
    const categoryIds = toArray(params.categoryId);
    const vendorIds = toArray(params.vendorId);
    const statuses = toArray(params.status);

    const where: Prisma.ProductWhereInput = {
      isDeleted: false,
      ...(brands?.length ? { brand: { in: brands } } : {}),
      ...(brandIds?.length ? { brandId: { in: brandIds } } : {}),
      ...(categoryIds?.length ? { categoryId: { in: categoryIds } } : {}),
      ...(vendorIds?.length ? { vendorId: { in: vendorIds } } : {}),
      ...(statuses?.length ? { status: { in: statuses as any } } : {}),
      ...(params.imeiRequired !== undefined ? { imeiRequired: params.imeiRequired } : {}),
      ...(params.costPriceMin !== undefined || params.costPriceMax !== undefined
        ? { costPrice: { gte: params.costPriceMin, lte: params.costPriceMax } }
        : {}),
      ...(params.sellingPriceMin !== undefined || params.sellingPriceMax !== undefined
        ? { sellingPrice: { gte: params.sellingPriceMin, lte: params.sellingPriceMax } }
        : {}),
      ...(params.createdFrom || params.createdTo
        ? { createdAt: { gte: params.createdFrom ? new Date(params.createdFrom) : undefined, lte: params.createdTo ? new Date(params.createdTo) : undefined } }
        : {}),
      ...(params.search
        ? {
            OR: [
              { ean: { contains: params.search } },
              { model: { contains: params.search, mode: 'insensitive' } },
              { brand: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
              { vendor: { name: { contains: params.search, mode: 'insensitive' } } },
              { category: { name: { contains: params.search, mode: 'insensitive' } } },
              { imeiUnits: { some: { imei1: { contains: params.search } } } },
            ],
          }
        : {}),
      ...(params.outOfStock
        ? { stockLevels: { none: { quantity: { gt: 0 } } } }
        : params.lowStock
        ? { stockLevels: { some: {} }, AND: [{ NOT: { stockLevels: { none: {} } } }] }
        : {}),
      ...(params.warehouseId
        ? { stockLevels: { some: { warehouseId: params.warehouseId } } }
        : {}),
    };

    const sortField = params.sortBy || 'createdAt';
    const sortDir = params.sortDir || 'desc';
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      sortField === 'vendor' ? { vendor: { name: sortDir } }
      : sortField === 'category' ? { category: { name: sortDir } }
      : sortField === 'brand' ? { brand: sortDir }
      : { [sortField]: sortDir };

    return prisma.$transaction([
      prisma.product.findMany({
        where, orderBy, skip: params.skip, take: params.take,
        include: PRODUCT_INCLUDE,
      }),
      prisma.product.count({ where }),
    ]);
  },

  async bulkUpdate(ids: string[], data: Prisma.ProductUncheckedUpdateManyInput) {
    return prisma.product.updateMany({
      where: { id: { in: ids }, isDeleted: false },
      data,
    });
  },

  async getStats() {
    const [total, active, lowStock, outOfStock] = await prisma.$transaction([
      prisma.product.count({ where: { isDeleted: false } }),
      prisma.product.count({ where: { isDeleted: false, status: 'ACTIVE' } }),
      prisma.product.count({
        where: {
          isDeleted: false,
          stockLevels: { some: { quantity: { gt: 0 } } },
          AND: [{ NOT: { stockLevels: { none: {} } } }],
        },
      }),
      prisma.product.count({ where: { isDeleted: false, stockLevels: { none: { quantity: { gt: 0 } } } } }),
    ]);
    return { total, active, lowStock, outOfStock };
  },
};
