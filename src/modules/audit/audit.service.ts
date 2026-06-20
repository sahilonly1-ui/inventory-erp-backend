import { prisma } from '../../config/prisma';
import { NotFoundError, BadRequestError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';

interface Actor { id: string; ip: string | null; }

// Fields on the audit JSON payloads that are metadata, not real product
// columns — never write these back onto a row during restore.
const META_KEYS = new Set(['categoryName', 'batchId', 'batchLabel', 'bulk', 'restoredFrom', 'restoredFromAuditId']);

export const auditService = {
  // Paginated, reverse-chronological feed across the whole system.
  // Enriches product-entity rows with a live model/ean/isDeleted snapshot so
  // the UI can show "what this row is" even if it's been renamed since.
  async list(params: { page: number; limit: number; entityName?: string; action?: string }) {
    const where: any = {};
    if (params.entityName) where.entityName = params.entityName;
    if (params.action) where.action = params.action;

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Batch-resolve user names
    const userIds = [...new Set(logs.map(l => l.userId).filter(Boolean))] as string[];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } })
      : [];
    const userMap = new Map(users.map(u => [u.id, u.fullName || u.email]));

    // Batch-resolve product context (current model/ean/isDeleted) for product rows
    const productIds = [...new Set(logs.filter(l => l.entityName === 'products').map(l => l.entityId))];
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, model: true, ean: true, isDeleted: true } })
      : [];
    const productMap = new Map(products.map(p => [p.id, p]));

    const items = logs.map(l => ({
      ...l,
      userName: l.userId ? (userMap.get(l.userId) || 'Unknown user') : 'System',
      entity: l.entityName === 'products' ? (productMap.get(l.entityId) || null) : null,
    }));

    return { items, total, page: params.page, limit: params.limit, totalPages: Math.ceil(total / params.limit) };
  },

  // Restore a single audit entry:
  //  - DELETE-flavoured entries (action DELETE, or an UPDATE that set isDeleted:true) → undelete the row
  //  - UPDATE entries → revert every field captured in oldValue back onto the row
  //  - CREATE entries → not restorable (nothing to revert to)
  async restore(auditId: string, actor: Actor) {
    const log = await prisma.auditLog.findUnique({ where: { id: auditId } });
    if (!log) throw new NotFoundError('Audit entry not found');
    if (log.entityName !== 'products') throw new BadRequestError('Restore is currently only supported for product changes');

    const newVal = (log.newValue as any) || {};
    const isDeleteFlavoured = log.action === 'DELETE' || newVal.isDeleted === true;

    if (isDeleteFlavoured) return this.restoreDeletedProduct(log.entityId, actor);

    if (log.action === 'CREATE') throw new BadRequestError('Cannot restore a creation — there is nothing to revert to');

    // UPDATE: revert every real (non-metadata) field captured in oldValue
    const oldVal = (log.oldValue as any) || {};
    const revertData: Record<string, any> = {};
    for (const k of Object.keys(oldVal)) {
      if (META_KEYS.has(k)) continue;
      revertData[k] = oldVal[k];
    }
    if (!Object.keys(revertData).length) throw new BadRequestError('Nothing to restore from this entry');

    const product = await prisma.product.findUnique({ where: { id: log.entityId } });
    if (!product) throw new NotFoundError('Product no longer exists');

    // Capture what we're reverting FROM, so this restore is itself undo-able
    const beforeRevert: Record<string, any> = {};
    for (const k of Object.keys(revertData)) beforeRevert[k] = (product as any)[k];

    await prisma.product.update({ where: { id: log.entityId }, data: { ...revertData, updatedBy: actor.id } });

    await writeAudit(prisma, {
      userId: actor.id, action: 'RESTORE', entityName: 'products', entityId: log.entityId,
      oldValue: beforeRevert, newValue: { ...revertData, restoredFromAuditId: auditId },
      ipAddress: actor.ip,
    });

    return { restored: true, productId: log.entityId };
  },

  // Shared undelete logic — also revives brand/category if they were
  // cascade-removed and are now back in use by this restored product.
  async restoreDeletedProduct(productId: string, actor: Actor) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundError('Product not found');
    if (!product.isDeleted) return { restored: false, message: 'Product is not currently deleted', productId };

    await prisma.product.update({
      where: { id: productId },
      data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: actor.id },
    });

    if (product.brand) {
      await prisma.brand.updateMany({
        where: { name: product.brand, isDeleted: true },
        data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: actor.id },
      });
    }
    if (product.categoryId) {
      await prisma.productCategory.updateMany({
        where: { id: product.categoryId, isDeleted: true },
        data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: actor.id },
      });
    }

    await writeAudit(prisma, {
      userId: actor.id, action: 'RESTORE', entityName: 'products', entityId: productId,
      oldValue: { isDeleted: true }, newValue: { isDeleted: false, restoredFrom: 'delete' },
      ipAddress: actor.ip,
    });

    return { restored: true, productId };
  },
};
