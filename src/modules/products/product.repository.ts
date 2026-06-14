import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

export const productRepository = {
  findById(id: string) {
    return prisma.product.findFirst({ where: { id, isDeleted: false } });
  },
  findByEan(ean: string) {
    return prisma.product.findFirst({ where: { ean, isDeleted: false } });
  },
  list(params: {
    search?: string; brand?: string; categoryId?: string; vendorId?: string;
    imeiRequired?: boolean; skip: number; take: number;
  }) {
    const where: Prisma.ProductWhereInput = {
      isDeleted: false,
      ...(params.brand ? { brand: params.brand } : {}),
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.vendorId ? { vendorId: params.vendorId } : {}),
      ...(params.imeiRequired !== undefined ? { imeiRequired: params.imeiRequired } : {}),
      ...(params.search
        ? {
            OR: [
              { ean: { contains: params.search } },
              { sku: { contains: params.search, mode: 'insensitive' } },
              { model: { contains: params.search, mode: 'insensitive' } },
              { brand: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return prisma.$transaction([
      prisma.product.findMany({ where, orderBy: { createdAt: 'desc' }, skip: params.skip, take: params.take }),
      prisma.product.count({ where }),
    ]);
  },
};
