import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ConflictError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';

interface Actor { id: string; ip: string | null; }

export const vendorService = {
  async create(input: Prisma.VendorUncheckedCreateInput, actor: Actor) {
    const dup = await prisma.vendor.findFirst({ where: { code: input.code, isDeleted: false } });
    if (dup) throw new ConflictError('Vendor code already exists');
    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({ data: { ...input, createdBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'CREATE', entityName: 'vendors', entityId: vendor.id, newValue: { code: vendor.code, name: vendor.name }, ipAddress: actor.ip });
      return vendor;
    });
  },

  list() {
    return prisma.vendor.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' } });
  },

  async get(id: string) {
    const vendor = await prisma.vendor.findFirst({ where: { id, isDeleted: false } });
    if (!vendor) throw new NotFoundError('Vendor not found');
    return vendor;
  },

  async update(id: string, input: Prisma.VendorUncheckedUpdateInput, actor: Actor) {
    const existing = await prisma.vendor.findFirst({ where: { id, isDeleted: false } });
    if (!existing) throw new NotFoundError('Vendor not found');
    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.update({ where: { id }, data: { ...input, updatedBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'UPDATE', entityName: 'vendors', entityId: id, newValue: input, ipAddress: actor.ip });
      return vendor;
    });
  },

  async remove(id: string, actor: Actor) {
    const existing = await prisma.vendor.findFirst({ where: { id, isDeleted: false } });
    if (!existing) throw new NotFoundError('Vendor not found');
    await prisma.$transaction(async (tx) => {
      await tx.vendor.update({ where: { id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'DELETE', entityName: 'vendors', entityId: id, ipAddress: actor.ip });
    });
  },

  // Current stock of products belonging to this vendor, per product + total.
  async vendorStock(vendorId: string) {
    const products = await prisma.product.findMany({
      where: { vendorId, isDeleted: false },
      select: { id: true, ean: true, sku: true, model: true, stockLevels: { select: { warehouseId: true, quantity: true } } },
    });
    const rows = products.map((p) => {
      const quantity = p.stockLevels.reduce((s, l) => s + l.quantity, 0);
      return { productId: p.id, ean: p.ean, sku: p.sku, model: p.model, quantity };
    });
    return { vendorId, totalUnits: rows.reduce((s, r) => s + r.quantity, 0), products: rows };
  },

  // Aging of vendor-attributed inbound stock, bucketed by receipt age.
  async vendorAging(vendorId: string) {
    const rows = await prisma.$queryRaw<
      { bucket_0_30: bigint; bucket_31_60: bigint; bucket_61_90: bigint; bucket_90_plus: bigint }[]
    >`
      SELECT
        COALESCE(SUM(CASE WHEN now() - "createdAt" <= interval '30 days' THEN quantity ELSE 0 END), 0) AS bucket_0_30,
        COALESCE(SUM(CASE WHEN now() - "createdAt" > interval '30 days' AND now() - "createdAt" <= interval '60 days' THEN quantity ELSE 0 END), 0) AS bucket_31_60,
        COALESCE(SUM(CASE WHEN now() - "createdAt" > interval '60 days' AND now() - "createdAt" <= interval '90 days' THEN quantity ELSE 0 END), 0) AS bucket_61_90,
        COALESCE(SUM(CASE WHEN now() - "createdAt" > interval '90 days' THEN quantity ELSE 0 END), 0) AS bucket_90_plus
      FROM inventory_transactions
      WHERE "vendorId" = ${vendorId} AND quantity > 0`;
    const r = rows[0];
    return {
      vendorId,
      aging: {
        '0-30': Number(r.bucket_0_30),
        '31-60': Number(r.bucket_31_60),
        '61-90': Number(r.bucket_61_90),
        '90+': Number(r.bucket_90_plus),
      },
    };
  },
};
