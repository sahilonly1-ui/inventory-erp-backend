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

  // Grouped feed: one row per batch of related changes.
  //
  // A single stock-in of 100 units writes 100 audit rows. Listed individually
  // they bury everything else and give no sense of what was actually done, so
  // changes made by the same user, to the same entity, with the same action,
  // within the same minute are collapsed into one entry carrying the product
  // names and quantities.
  async listGrouped(params: { page: number; limit: number; entityName?: string; action?: string }) {
    const conds: string[] = [];
    const vals: any[] = [];
    if (params.entityName) { vals.push(params.entityName); conds.push(`"entityName" = $${vals.length}`); }
    if (params.action)     { vals.push(params.action);     conds.push(`action = $${vals.length}`); }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const offset = (params.page - 1) * params.limit;

    const groups = (await (prisma as any).$queryRawUnsafe(
      `SELECT
         MIN(id::text)                          AS "anchorId",
         "userId",
         "entityName",
         action,
         date_trunc('minute', "createdAt")       AS bucket,
         COUNT(*)::int                           AS "changeCount",
         MAX("createdAt")                        AS "createdAt",
         array_agg(id::text ORDER BY "createdAt") AS ids
       FROM audit_logs
       ${whereSql}
       GROUP BY "userId", "entityName", action, date_trunc('minute', "createdAt")
       ORDER BY MAX("createdAt") DESC
       LIMIT ${params.limit} OFFSET ${offset}`,
      ...vals,
    )) as any[];

    const totalRows = (await (prisma as any).$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT 1 FROM audit_logs ${whereSql}
         GROUP BY "userId", "entityName", action, date_trunc('minute', "createdAt")
       ) g`,
      ...vals,
    )) as any[];
    const total = Number(totalRows[0]?.n ?? 0);

    if (!groups.length) {
      return { items: [], total, page: params.page, limit: params.limit, totalPages: Math.ceil(total / params.limit) };
    }

    // Pull the member rows so each group can describe itself.
    const allIds = groups.flatMap(g => (g.ids as string[]).slice(0, 200));
    const logs = await prisma.auditLog.findMany({ where: { id: { in: allIds } } });
    const logById = new Map(logs.map(l => [l.id, l]));

    // Resolve display names in one pass rather than per group.
    const productIds = new Set<string>();
    for (const l of logs) {
      const nv: any = l.newValue || {};
      const ov: any = l.oldValue || {};
      if (l.entityName === 'products') productIds.add(l.entityId);
      if (nv.productId) productIds.add(nv.productId);
      if (ov.productId) productIds.add(ov.productId);
    }
    const products = productIds.size
      ? await prisma.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, model: true, ean: true } })
      : [];
    const productMap = new Map<string, { id: string; model: string; ean: string }>(
      products.map((p: any) => [p.id as string, p as { id: string; model: string; ean: string }]));

    const userIds = [...new Set(groups.map(g => g.userId).filter(Boolean))] as string[];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } })
      : [];
    const userMap = new Map(users.map(u => [u.id, u.fullName || u.email]));

    const items = groups.map(g => {
      const members = (g.ids as string[]).map(id => logById.get(id)).filter(Boolean) as typeof logs;

      // Roll members up into "product → units" so the entry reads like the
      // action the operator actually performed.
      const perProduct = new Map<string, number>();
      let unitTotal = 0;
      for (const m of members) {
        const nv: any = m.newValue || {};
        const ov: any = m.oldValue || {};

        // A bulk-delete row already carries its own product breakdown.
        if (ov.bulk && ov.products) {
          for (const [model, qty] of Object.entries(ov.products as Record<string, number>)) {
            perProduct.set(model, (perProduct.get(model) || 0) + Number(qty));
            unitTotal += Number(qty);
          }
          continue;
        }

        const pid = nv.productId || ov.productId || (m.entityName === 'products' ? m.entityId : null);
        const name = ov.product || nv.model || ov.model || (pid ? productMap.get(pid)?.model : null) || 'Unknown item';
        const qty = Math.abs(Number(nv.quantity ?? ov.quantity ?? 0)) || 1;
        perProduct.set(name, (perProduct.get(name) || 0) + qty);
        unitTotal += qty;
      }

      const lines = [...perProduct.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([model, qty]) => ({ model, qty }));

      return {
        id: g.anchorId,
        ids: g.ids,
        action: g.action,
        entityName: g.entityName,
        createdAt: g.createdAt,
        userName: g.userId ? (userMap.get(g.userId) || 'Unknown user') : 'System',
        changeCount: g.changeCount,
        unitTotal,
        products: lines,
        // Single-change groups behave exactly like the old flat rows.
        single: g.changeCount === 1 ? logById.get((g.ids as string[])[0]) ?? null : null,
      };
    });

    return { items, total, page: params.page, limit: params.limit, totalPages: Math.ceil(total / params.limit) };
  },

  // Restore every entry in a grouped batch.
  //
  // A batch mixes rows that can and cannot be reverted (a creation has nothing
  // to revert to), and reverting a hundred rows blindly is exactly how data
  // gets lost. So this runs in two modes: dryRun reports what would happen,
  // and the real pass applies only the entries it can, reporting the rest.
  async restoreBatch(auditIds: string[], actor: Actor, dryRun = false) {
    if (!auditIds?.length) throw new BadRequestError('No entries selected');

    const logs = await prisma.auditLog.findMany({ where: { id: { in: auditIds } } });
    if (!logs.length) throw new NotFoundError('No audit entries found for this batch');

    const plan: { auditId: string; label: string; willRestore: boolean; reason?: string }[] = [];

    // Resolve product names once so the preview reads in plain language.
    const productIds = new Set<string>();
    for (const l of logs) {
      const nv: any = l.newValue || {};
      const ov: any = l.oldValue || {};
      if (l.entityName === 'products') productIds.add(l.entityId);
      if (nv.productId) productIds.add(nv.productId);
      if (ov.productId) productIds.add(ov.productId);
    }
    const products = productIds.size
      ? await prisma.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, model: true } })
      : [];
    const nameById = new Map<string, string>(products.map((p: any) => [p.id as string, p.model as string]));

    const labelFor = (l: typeof logs[number]) => {
      const nv: any = l.newValue || {};
      const ov: any = l.oldValue || {};
      const pid = nv.productId || ov.productId || (l.entityName === 'products' ? l.entityId : null);
      return ov.product || nv.model || ov.model || (pid ? nameById.get(pid) : null) || l.entityName;
    };

    for (const l of logs) {
      const nv: any = l.newValue || {};
      const isDeleteFlavoured = l.action === 'DELETE' || nv.isDeleted === true;
      const label = labelFor(l);

      if (l.entityName !== 'products') {
        plan.push({ auditId: l.id, label, willRestore: false, reason: 'Only product changes can be reverted' });
      } else if (l.action === 'CREATE' && !isDeleteFlavoured) {
        plan.push({ auditId: l.id, label, willRestore: false, reason: 'Creation — nothing to revert to' });
      } else if (l.action === 'LOGIN') {
        plan.push({ auditId: l.id, label, willRestore: false, reason: 'Not a data change' });
      } else {
        plan.push({ auditId: l.id, label, willRestore: true });
      }
    }

    const doable = plan.filter(p => p.willRestore);
    if (dryRun) {
      return {
        dryRun: true,
        total: plan.length,
        restorable: doable.length,
        skipped: plan.length - doable.length,
        plan: plan.slice(0, 50),
      };
    }
    if (!doable.length) {
      throw new BadRequestError('Nothing in this batch can be reverted');
    }

    // Apply one at a time: a single failure must not roll back the others,
    // and each restore writes its own audit trail.
    let restored = 0;
    const failures: { label: string; error: string }[] = [];
    for (const item of doable) {
      try {
        await this.restore(item.auditId, actor);
        restored++;
      } catch (e: any) {
        failures.push({ label: item.label, error: e?.message ?? 'Unknown error' });
      }
    }

    return {
      dryRun: false,
      total: plan.length,
      restored,
      skipped: plan.length - doable.length,
      failed: failures.length,
      failures: failures.slice(0, 20),
    };
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
