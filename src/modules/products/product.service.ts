import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ConflictError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { productRepository } from './product.repository';

interface Actor { id: string; ip: string | null; }

export const productService = {
  async create(input: Prisma.ProductUncheckedCreateInput, actor: Actor) {
    const dup = await prisma.product.findFirst({
      where: { isDeleted: false, OR: [{ ean: input.ean }, { sku: input.sku }] },
    });
    if (dup) throw new ConflictError('A product with this EAN or SKU already exists');

    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { ...input, createdBy: actor.id } });
      await writeAudit(tx, {
        userId: actor.id, action: 'CREATE', entityName: 'products', entityId: product.id,
        newValue: { ean: product.ean, sku: product.sku, model: product.model }, ipAddress: actor.ip,
      });
      return product;
    });
  },

  async list(input: {
    search?: string; brand?: string; categoryId?: string; vendorId?: string;
    imeiRequired?: boolean; page: number; limit: number;
  }) {
    const [items, total] = await productRepository.list({
      ...input, skip: (input.page - 1) * input.limit, take: input.limit,
    });
    return { items, page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) };
  },

  async get(id: string) {
    const product = await productRepository.findById(id);
    if (!product) throw new NotFoundError('Product not found');
    return product;
  },

  async update(id: string, input: Prisma.ProductUncheckedUpdateInput, actor: Actor) {
    const existing = await productRepository.findById(id);
    if (!existing) throw new NotFoundError('Product not found');
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.update({ where: { id }, data: { ...input, updatedBy: actor.id } });
      await writeAudit(tx, {
        userId: actor.id, action: 'UPDATE', entityName: 'products', entityId: id,
        oldValue: { ean: existing.ean, sku: existing.sku }, newValue: input, ipAddress: actor.ip,
      });
      return product;
    });
  },

  async remove(id: string, actor: Actor) {
    const existing = await productRepository.findById(id);
    if (!existing) throw new NotFoundError('Product not found');
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
      });
      await writeAudit(tx, { userId: actor.id, action: 'DELETE', entityName: 'products', entityId: id, ipAddress: actor.ip });
    });
  },

  async restore(id: string, actor: Actor) {
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product || !product.isDeleted) throw new NotFoundError('Deleted product not found');
    return prisma.$transaction(async (tx) => {
      const restored = await tx.product.update({
        where: { id }, data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: actor.id },
      });
      await writeAudit(tx, { userId: actor.id, action: 'RESTORE', entityName: 'products', entityId: id, ipAddress: actor.ip });
      return restored;
    });
  },

  // minimal category management
  createCategory(input: { name: string; parentId?: string }, actor: Actor) {
    return prisma.productCategory.create({ data: { ...input, createdBy: actor.id } });
  },
  listCategories() {
    return prisma.productCategory.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' } });
  },
};
