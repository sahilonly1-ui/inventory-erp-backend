import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import { ConflictError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { productRepository } from './product.repository';

interface Actor { id: string; ip: string | null; }

// Soft-delete brands/categories that no longer have ANY active product referencing them.
// Categories are cleaned up in passes so a parent becomes eligible once its
// now-empty children are removed first.
async function cascadeCleanup(brandNames: string[], categoryIds: string[], actor: Actor) {
  let brandsRemoved = 0, categoriesRemoved = 0;

  for (const brandName of brandNames) {
    if (!brandName) continue;
    const remaining = await prisma.product.count({ where: { brand: brandName, isDeleted: false } });
    if (remaining === 0) {
      const r = await prisma.brand.updateMany({
        where: { name: brandName, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
      });
      brandsRemoved += r.count;
    }
  }

  let pending = new Set(categoryIds.filter(Boolean));
  for (let pass = 0; pass < 6 && pending.size > 0; pass++) {
    const removable: string[] = [];
    for (const catId of pending) {
      const remainingProducts = await prisma.product.count({ where: { categoryId: catId, isDeleted: false } });
      const childCount = await prisma.productCategory.count({ where: { parentId: catId, isDeleted: false } });
      if (remainingProducts === 0 && childCount === 0) removable.push(catId);
    }
    if (!removable.length) break;
    await prisma.productCategory.updateMany({
      where: { id: { in: removable } },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
    });
    categoriesRemoved += removable.length;
    const parents = await prisma.productCategory.findMany({
      where: { id: { in: removable } }, select: { parentId: true },
    });
    pending = new Set(parents.map(p => p.parentId).filter(Boolean) as string[]);
  }

  return { brandsRemoved, categoriesRemoved };
}

export const productService = {
  // ── PRODUCTS ─────────────────────────────────────────────────────────────
  async create(input: any, actor: Actor) {
    const dup = await prisma.product.findFirst({
      where: { isDeleted: false, ean: input.ean },
    });
    if (dup) throw new ConflictError('A product with this EAN already exists');
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { ...input, sku: input.ean, createdBy: actor.id },
      });
      await writeAudit(tx, {
        userId: actor.id, action: 'CREATE', entityName: 'products',
        entityId: product.id, newValue: { ean: product.ean, model: product.model },
        ipAddress: actor.ip,
      });
      return product;
    });
  },

  // Bulk delete — soft-delete by ID list, then cascade-clean empty brands/categories
  async bulkDelete(ids: string[], actor: Actor) {
    if (!ids?.length) return { deleted: 0, brandsRemoved: 0, categoriesRemoved: 0 };

    const toDelete = await prisma.product.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, ean: true, model: true, brand: true, categoryId: true },
    });
    if (!toDelete.length) return { deleted: 0, brandsRemoved: 0, categoriesRemoved: 0 };

    const brandNames  = [...new Set(toDelete.map(p => p.brand).filter(Boolean))] as string[];
    const categoryIds = [...new Set(toDelete.map(p => p.categoryId).filter(Boolean))] as string[];

    const result = await prisma.product.updateMany({
      where: { id: { in: ids }, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id },
    });

    const batchId = randomUUID();
    await prisma.auditLog.createMany({
      data: toDelete.map(p => ({
        userId: actor.id, action: 'DELETE' as const, entityName: 'products', entityId: p.id,
        oldValue: { ean: p.ean, model: p.model, brand: p.brand, isDeleted: false },
        newValue: { isDeleted: true, batchId, batchLabel: 'Bulk Delete' },
        ipAddress: actor.ip,
      })),
    });

    const cascade = await cascadeCleanup(brandNames, categoryIds, actor);
    return { deleted: result.count, ...cascade };
  },

  // Delete ALL active products at once — cascades to empty brands/categories too
  async deleteAllProducts(actor: Actor) {
    const active = await prisma.product.findMany({
      where: { isDeleted: false },
      select: { id: true, ean: true, model: true, brand: true, categoryId: true },
    });
    if (!active.length) return { deleted: 0, brandsRemoved: 0, categoriesRemoved: 0 };

    const brandNames  = [...new Set(active.map(p => p.brand).filter(Boolean))] as string[];
    const categoryIds = [...new Set(active.map(p => p.categoryId).filter(Boolean))] as string[];

    const result = await prisma.product.updateMany({
      where: { isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id },
    });

    const batchId = randomUUID();
    await prisma.auditLog.createMany({
      data: active.map(p => ({
        userId: actor.id, action: 'DELETE' as const, entityName: 'products', entityId: p.id,
        oldValue: { ean: p.ean, model: p.model, brand: p.brand, isDeleted: false },
        newValue: { isDeleted: true, batchId, batchLabel: 'Delete ALL Products' },
        ipAddress: actor.ip,
      })),
    });

    const cascade = await cascadeCleanup(brandNames, categoryIds, actor);
    return { deleted: result.count, ...cascade };
  },

    // Bulk import — supports Action column: UPDATE (default, upsert) or DELETE
  async bulkImport(rows: any[], actor: Actor) {
    const VALID_STATUS = new Set(['ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED']);

    const normalizedAll = rows.filter(r => r.ean).map(r => ({
      ean:          String(r.ean   || '').trim(),
      action:       String(r.action || 'UPDATE').trim().toUpperCase(), // UPDATE | DELETE
      model:        String(r.model || '').trim(),
      brand:        String(r.brand || '').trim(),
      categoryId:   r.categoryId   || null,                                  // matched on frontend, may be empty
      categoryName: String(r.categoryName || r._category || '').trim() || null, // raw CSV text — used to auto-create if no match
      status:       VALID_STATUS.has(String(r.status||'').toUpperCase()) ? String(r.status).toUpperCase() : 'ACTIVE',
      costPrice:    Number(r.costPrice)    || 0,
      sellingPrice: Number(r.sellingPrice) || 0,
      gstRate:      Number(r.gstRate)      || 18,
      hsnCode:      String(r.hsnCode || ''),
      minStock:     Number(r.minStock)     || 0,
    }));

    // De-duplicate WITHIN the uploaded file itself: EAN is the single source of truth for
    // identity, so if the same EAN appears more than once in this CSV, keep only the LAST
    // occurrence (the most likely "final" value if someone edited a row further down) and
    // drop the earlier ones. Prevents one file from ever producing duplicate EANs.
    const dedupMap = new Map<string, typeof normalizedAll[number]>();
    let inFileDuplicates = 0;
    for (const r of normalizedAll) {
      if (dedupMap.has(r.ean)) inFileDuplicates++;
      dedupMap.set(r.ean, r); // later occurrence overwrites earlier one
    }
    const normalized = [...dedupMap.values()];

    const batchId = randomUUID(); // groups every audit entry from this single import call

    // Self-heal: merge any pre-existing duplicate-named categories before matching/creating
    // new ones. This is what actually fixes "category created multiple times" — without
    // this, a stale frontend categories list (or repeated retries) can keep matching nothing
    // and creating fresh rows for a name that already exists.
    await this.deduplicateCategories();

    // Self-heal: merge any leftover duplicate PRODUCT rows sharing an EAN (e.g. soft-deleted
    // "ghosts" left over from earlier bugs). Without this, the update step below can match
    // and revive ALL rows sharing an EAN — including dead ones — which looks like the import
    // "duplicated products".
    await this.deduplicateProductsByEan(actor);

    // ── DELETE rows: soft-delete by EAN, then cascade-clean empty brands/categories ──
    const deleteRows = normalized.filter(r => r.action === 'DELETE');
    let deletedCount = 0, brandsRemoved = 0, categoriesRemoved = 0;
    if (deleteRows.length) {
      const delEans = deleteRows.map(r => r.ean);
      const toDelete = await prisma.product.findMany({
        where: { ean: { in: delEans }, isDeleted: false },
        select: { id: true, ean: true, model: true, brand: true, categoryId: true },
      });
      if (toDelete.length) {
        const delIds = toDelete.map(p => p.id);
        const delBrandNames  = [...new Set(toDelete.map(p => p.brand).filter(Boolean))] as string[];
        const delCategoryIds = [...new Set(toDelete.map(p => p.categoryId).filter(Boolean))] as string[];
        await prisma.product.updateMany({
          where: { id: { in: delIds } },
          data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id },
        });
        deletedCount = delIds.length;
        const cascade = await cascadeCleanup(delBrandNames, delCategoryIds, actor);
        brandsRemoved = cascade.brandsRemoved;
        categoriesRemoved = cascade.categoriesRemoved;

        await prisma.auditLog.createMany({
          data: toDelete.map(p => ({
            userId: actor.id, action: 'DELETE' as const, entityName: 'products', entityId: p.id,
            oldValue: { ean: p.ean, model: p.model, brand: p.brand, isDeleted: false },
            newValue: { isDeleted: true, batchId, batchLabel: 'Bulk Import — Delete' },
            ipAddress: actor.ip,
          })),
        });
      }
    }

    // ── UPDATE rows (default action): upsert by EAN — requires model too ──
    const validRows = normalized.filter(r => r.action !== 'DELETE' && r.model);

    if (!validRows.length) {
      return { created: 0, updated: 0, deleted: deletedCount, brandsRemoved, categoriesRemoved, brandsCreated: 0, categoriesCreated: 0, inFileDuplicates, errors: deleteRows.length ? [] : ['No valid rows'], totalErrors: deleteRows.length ? 0 : 1 };
    }

    // ── Auto-create Brand master entries for any brand name not seen before ──
    let brandsCreated = 0;
    const brandNamesNeeded = [...new Set(validRows.map(r => r.brand).filter(Boolean))] as string[];
    if (brandNamesNeeded.length) {
      const existingBrands = await prisma.brand.findMany({
        where: { name: { in: brandNamesNeeded } }, select: { name: true, isDeleted: true },
      });
      const existingNameSet = new Set(existingBrands.map(b => b.name));
      const newBrandNames = brandNamesNeeded.filter(n => !existingNameSet.has(n));
      if (newBrandNames.length) {
        const res = await prisma.brand.createMany({
          data: newBrandNames.map(name => ({ name, createdBy: actor.id })),
          skipDuplicates: true,
        });
        brandsCreated = res.count;
      }
      // Revive any brand that was previously cascade-deleted (now back in use)
      const deletedButReused = existingBrands.filter(b => b.isDeleted).map(b => b.name);
      if (deletedButReused.length) {
        await prisma.brand.updateMany({
          where: { name: { in: deletedButReused } },
          data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: actor.id },
        });
      }
    }

    // ── Auto-create Category entries for any category name not matched to an ID ──
    // Matching is case-insensitive + trimmed so "NeckBands" / "Neckbands " / " neckbands"
    // all resolve to ONE category instead of spawning near-duplicates.
    let categoriesCreated = 0;
    const catNamesNeeded = [...new Set(
      validRows.filter(r => !r.categoryId && r.categoryName).map(r => (r.categoryName as string).trim())
    )].filter(Boolean);
    const catNameToId = new Map<string, string>();
    if (catNamesNeeded.length) {
      // Fetch ALL categories once (active + soft-deleted) — counts are small, exact-IN with
      // case folding isn't reliably supported across DB collations, so match in JS instead.
      const allCats = await prisma.productCategory.findMany({ select: { id: true, name: true, isDeleted: true } });
      const byLowerName = new Map<string, { id: string; name: string; isDeleted: boolean }>();
      for (const c of allCats) {
        const key = c.name.trim().toLowerCase();
        if (!byLowerName.has(key)) byLowerName.set(key, c); // first wins if somehow still duplicated
      }

      const toCreateNames: string[] = [];
      const toRevive: string[] = [];
      for (const name of catNamesNeeded) {
        const match = byLowerName.get(name.toLowerCase());
        if (match) {
          catNameToId.set(name, match.id);
          if (match.isDeleted) toRevive.push(match.id);
        } else {
          toCreateNames.push(name);
        }
      }

      if (toCreateNames.length) {
        await prisma.productCategory.createMany({
          data: toCreateNames.map(name => ({ name, createdBy: actor.id })),
          skipDuplicates: true,
        });
        categoriesCreated = toCreateNames.length;
        const justCreated = await prisma.productCategory.findMany({
          where: { name: { in: toCreateNames } }, select: { id: true, name: true },
        });
        for (const c of justCreated) catNameToId.set(c.name, c.id);
      }
      if (toRevive.length) {
        await prisma.productCategory.updateMany({
          where: { id: { in: toRevive } },
          data: { isDeleted: false, deletedAt: null, deletedBy: null, updatedBy: actor.id },
        });
      }
    }
    // Backfill resolved categoryId onto rows that didn't have one (match trimmed, same as lookup build)
    for (const r of validRows) {
      const trimmedName = r.categoryName ? (r.categoryName as string).trim() : '';
      if (!r.categoryId && trimmedName && catNameToId.has(trimmedName)) {
        (r as any).categoryId = catNameToId.get(trimmedName);
      }
    }

    // Step 1: find existing EANs in ONE query — capture full snapshot for audit diffs.
    // CRITICAL: isDeleted:false here — without it, soft-deleted ghost rows count as
    // "existing", which both skips creating a fresh active row AND lets the later
    // raw-SQL update revive the dead row instead (the actual cause of "duplicated products").
    const allEans = validRows.map(r => r.ean);
    const existing = await prisma.product.findMany({
      where: { ean: { in: allEans }, isDeleted: false },
      select: { id: true, ean: true, model: true, brand: true, categoryId: true, status: true,
                costPrice: true, sellingPrice: true, gstRate: true, hsnCode: true, minStock: true },
    });
    const existingSet = new Set(existing.map(p => p.ean));
    const existingByEan = new Map(existing.map(p => [p.ean, p]));
    const toCreate = validRows.filter(r => !existingSet.has(r.ean));
    const toUpdate = validRows.filter(r =>  existingSet.has(r.ean));

    let created = 0, updated = 0;
    const errors: string[] = [];

    // Step 2: createMany for ALL new products — one query
    if (toCreate.length > 0) {
      try {
        const res = await prisma.product.createMany({
          data: toCreate.map(r => ({
            ean:          r.ean,
            sku:          r.ean,
            model:        r.model,
            brand:        r.brand,
            categoryId:   r.categoryId || undefined,
            status:       r.status as any,
            costPrice:    Number(r.costPrice)    || 0,
            sellingPrice: Number(r.sellingPrice) || 0,
            gstRate:      Number(r.gstRate)      || 18,
            hsnCode:      r.hsnCode || undefined,
            minStock:     Number(r.minStock)     || 0,
            isDeleted:    false,
            imeiRequired: false,
            serialRequired: false,
            createdBy:    actor.id,
          })),
          skipDuplicates: true,
        });
        created = res.count;

        // Audit each newly-created product (batched insert, fast even for thousands of rows)
        if (created > 0) {
          const createdEans = toCreate.map(r => r.ean);
          const createdProducts = await prisma.product.findMany({
            where: { ean: { in: createdEans }, isDeleted: false },
            select: { id: true, ean: true, model: true, brand: true, categoryId: true, status: true, costPrice: true, sellingPrice: true },
          });
          await prisma.auditLog.createMany({
            data: createdProducts.map(p => ({
              userId: actor.id, action: 'CREATE' as const, entityName: 'products', entityId: p.id,
              newValue: { ean: p.ean, model: p.model, brand: p.brand, categoryId: p.categoryId,
                          status: p.status, costPrice: p.costPrice, sellingPrice: p.sellingPrice,
                          batchId, batchLabel: 'Bulk Import' },
              ipAddress: actor.ip,
            })),
          });
        }
      } catch(e: any) { errors.push('Create error: ' + String(e.message).slice(0,150)); }
    }

    // Step 3: raw SQL UPDATE for all existing products, CHUNKED to stay under
    // PostgreSQL's 32,767 bind-parameter limit (10 params/row → max ~3000 rows/stmt;
    // we use 1500 for a safe margin).
    if (toUpdate.length > 0) {
      const UPDATE_CHUNK = 1500;
      for (let ci = 0; ci < toUpdate.length; ci += UPDATE_CHUNK) {
        const chunk = toUpdate.slice(ci, ci + UPDATE_CHUNK);
        try {
          const params: any[] = [];
          const valuesClauses: string[] = [];

          chunk.forEach(r => {
            const base = params.length;
            params.push(
              r.ean,                 // ean (join key)
              r.model,                // model
              r.brand,                 // brand
              r.categoryId || null,    // categoryId
              r.status,                // status
              r.costPrice,              // costPrice
              r.sellingPrice,            // sellingPrice
              r.gstRate,                  // gstRate
              r.hsnCode,                   // hsnCode
              r.minStock,                   // minStock
            );
            valuesClauses.push(
              `($${base+1},$${base+2},$${base+3},$${base+4}::text,$${base+5}::text,$${base+6}::numeric,$${base+7}::numeric,$${base+8}::numeric,$${base+9},$${base+10}::int)`
            );
          });
          params.push(actor.id); // last param = updatedBy

          const updatedByParam = `$${params.length}`;
          const sql = `
            UPDATE products SET
              "model"        = v.model,
              "brand"        = v.brand,
              "categoryId"   = v.cat_id,
              "status"       = v.st::"ProductStatus",
              "costPrice"    = v.cp,
              "sellingPrice" = v.sp,
              "gstRate"      = v.gst,
              "hsnCode"      = v.hsn,
              "minStock"     = v.ms,
              "isDeleted"    = false,
              "updatedAt"    = NOW(),
              "updatedBy"    = ${updatedByParam}
            FROM (VALUES ${valuesClauses.join(',')})
              AS v(ean, model, brand, cat_id, st, cp, sp, gst, hsn, ms)
            WHERE products.ean = v.ean AND products."isDeleted" = false
          `;

          await prisma.$executeRawUnsafe(sql, ...params);
          updated += chunk.length;

          // Audit each updated product with a true before/after diff (batched insert)
          const auditRows = chunk
            .map(r => {
              const before = existingByEan.get(r.ean);
              if (!before) return null;
              const oldValue: Record<string, any> = {};
              const newValue: Record<string, any> = { batchId, batchLabel: 'Bulk Import' };
              const fieldPairs: [string, any, any][] = [
                ['model', before.model, r.model],
                ['brand', before.brand, r.brand],
                ['categoryId', before.categoryId, r.categoryId || null],
                ['status', before.status, r.status],
                ['costPrice', Number(before.costPrice), r.costPrice],
                ['sellingPrice', Number(before.sellingPrice), r.sellingPrice],
              ];
              for (const [key, oldV, newV] of fieldPairs) {
                if (String(oldV) !== String(newV)) { oldValue[key] = oldV; newValue[key] = newV; }
              }
              if (!Object.keys(newValue).length || (Object.keys(newValue).length === 2 && newValue.batchId)) return null;
              return {
                userId: actor.id, action: 'UPDATE' as const, entityName: 'products', entityId: before.id,
                oldValue, newValue, ipAddress: actor.ip,
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);

          if (auditRows.length) await prisma.auditLog.createMany({ data: auditRows });
        } catch(e: any) {
          errors.push(`Update chunk ${ci}-${ci+chunk.length} error: ` + String(e.message).slice(0,180));
        }
      }
    }

    return { created, updated, deleted: deletedCount, brandsRemoved, categoriesRemoved, brandsCreated, categoriesCreated, inFileDuplicates, errors: errors.slice(0,20), totalErrors: errors.length };
  },

  async list(input: {
    search?: string; brand?: string | string[]; brandId?: string | string[];
    categoryId?: string | string[]; vendorId?: string | string[];
    warehouseId?: string; imeiRequired?: boolean; status?: string | string[];
    costPriceMin?: number; costPriceMax?: number;
    sellingPriceMin?: number; sellingPriceMax?: number;
    createdFrom?: string; createdTo?: string;
    lowStock?: boolean; outOfStock?: boolean;
    page: number; limit: number; sortBy?: string; sortDir?: 'asc' | 'desc';
  }) {
    const [items, total] = await productRepository.list({
      ...input, skip: (input.page - 1) * input.limit, take: input.limit,
    });
    return { items, page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) };
  },

  async get(id: string) {
    const product = await productRepository.findById(id);
    if (!product) throw new NotFoundError('Product not found');
    // enrich with audit history
    const history = await prisma.auditLog.findMany({
      where: { entityName: 'products', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { ...product, history };
  },

  async update(id: string, input: any, actor: Actor) {
    const existing = await productRepository.findById(id);
    if (!existing) throw new NotFoundError('Product not found');
    return prisma.$transaction(async (tx) => {
      // handle attributes separately
      const { attributes, ...productData } = input;
      const product = await tx.product.update({
        where: { id }, data: { ...productData, updatedBy: actor.id },
      });
      if (attributes) {
        for (const attr of attributes) {
          await tx.productAttribute.upsert({
            where: { productId_key: { productId: id, key: attr.key } },
            update: { value: attr.value, updatedAt: new Date() },
            create: { productId: id, key: attr.key, value: attr.value },
          });
        }
      }
      // Capture the BEFORE value for every field actually being changed —
      // not just a hardcoded subset — so history can show a true diff.
      const changedKeys = Object.keys(productData);
      const oldValue: Record<string, any> = {};
      for (const k of changedKeys) oldValue[k] = (existing as any)[k];

      // Resolve category name for both old and new categoryId so the
      // frontend can render a readable label without a second lookup.
      if (changedKeys.includes('categoryId')) {
        const [oldCat, newCat] = await Promise.all([
          oldValue.categoryId ? tx.productCategory.findUnique({ where: { id: oldValue.categoryId }, select: { name: true } }) : null,
          productData.categoryId ? tx.productCategory.findUnique({ where: { id: productData.categoryId }, select: { name: true } }) : null,
        ]);
        oldValue.categoryName = oldCat?.name ?? null;
        (productData as any).categoryName = newCat?.name ?? null;
      }

      await writeAudit(tx, {
        userId: actor.id, action: 'UPDATE', entityName: 'products', entityId: id,
        oldValue, newValue: productData, ipAddress: actor.ip,
      });
      return product;
    });
  },

  async bulkUpdate(ids: string[], data: any, actor: Actor) {
    const { attributes, ...productData } = data;
    await productRepository.bulkUpdate(ids, { ...productData, updatedBy: actor.id });
    for (const id of ids) {
      await writeAudit(prisma as any, {
        userId: actor.id, action: 'UPDATE', entityName: 'products', entityId: id,
        newValue: { bulk: true, ...productData }, ipAddress: actor.ip,
      });
    }
    return { updated: ids.length };
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
    // Same cascade rule as bulk delete: if this was the LAST active product
    // using this brand/category, remove the now-empty brand/category too.
    await cascadeCleanup(existing.brand ? [existing.brand] : [], existing.categoryId ? [existing.categoryId] : [], actor);
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

  async getStats() {
    return productRepository.getStats();
  },

  // ── BRANDS ───────────────────────────────────────────────────────────────
  async createBrand(input: { name: string }, actor: Actor) {
    const existing = await prisma.brand.findFirst({ where: { name: input.name, isDeleted: false } });
    if (existing) throw new ConflictError('Brand already exists');
    return prisma.brand.create({ data: { ...input, createdBy: actor.id } });
  },

  listBrands() {
    return prisma.brand.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' } });
  },

  // Bulk brand import via CSV rows: [{name, action}]
  async bulkImportBrands(rows: {name:string; action?:string}[], actor: Actor) {
    let created=0, updated=0, deleted=0, errors:string[]=[];
    for(const row of rows){
      const name=(row.name||'').trim();
      if(!name){ errors.push('Empty name skipped'); continue; }
      const action=(row.action||'ADD').toUpperCase().trim();
      try{
        const existing = await prisma.brand.findFirst({ where:{ name, isDeleted:false } });
        if(action==='DELETE'){
          if(existing){ await prisma.brand.update({ where:{id:existing.id}, data:{isDeleted:true,deletedAt:new Date(),deletedBy:actor.id} }); deleted++; }
        } else if(action==='UPDATE' || existing){
          if(existing){ await prisma.brand.update({ where:{id:existing.id}, data:{name, updatedBy:actor.id} }); updated++; }
          else { await prisma.brand.create({ data:{name, createdBy:actor.id} }); created++; }
        } else {
          await prisma.brand.create({ data:{name, createdBy:actor.id} }); created++;
        }
      }catch(e:any){ errors.push(`${name}: ${e.message?.slice(0,50)}`); }
    }
    return { created, updated, deleted, errors:errors.slice(0,20), totalErrors:errors.length };
  },

  async updateBrand(id: string, input: { name: string }, actor: Actor) {
    return prisma.brand.update({ where: { id }, data: { ...input, updatedBy: actor.id } });
  },

  async deleteBrand(id: string, actor: Actor) {
    return prisma.brand.update({
      where: { id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
    });
  },

  async mergeBrands(sourceIds: string[], targetId: string, actor: Actor) {
    // Move all products from source brands to target brand
    const target = await prisma.brand.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundError('Target brand not found');
    await prisma.$transaction(async (tx) => {
      // Update products brand text + brandId
      for (const sourceId of sourceIds) {
        const source = await tx.brand.findUnique({ where: { id: sourceId } });
        if (!source) continue;
        await tx.product.updateMany({
          where: { brandId: sourceId },
          data: { brandId: targetId, brand: target.name, updatedBy: actor.id },
        });
        await tx.brand.update({
          where: { id: sourceId },
          data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
        });
      }
    });
    return { merged: sourceIds.length, into: target.name };
  },

  // Sync brands from product.brand text field — bulk approach (no N+1 queries)
  async syncBrands(actor: Actor) {
    // 1. Get all unique brand names in ONE query
    const rawBrands = await prisma.product.findMany({
      where: { isDeleted: false, brand: { not: '' } },
      select: { brand: true },
      distinct: ['brand'],
    });
    const uniqueNames = [...new Set(rawBrands.map(r => r.brand.trim()).filter(Boolean))];

    // 2. Get existing brands in ONE query
    const existing = await prisma.brand.findMany({
      where: { isDeleted: false },
      select: { id: true, name: true },
    });
    const existingSet = new Set(existing.map(b => b.name));

    // 3. Create missing brands with createMany (single query)
    const toCreate = uniqueNames.filter(n => !existingSet.has(n)).map(name => ({ name, createdBy: actor.id }));
    let created = 0;
    if (toCreate.length > 0) {
      await prisma.brand.createMany({ data: toCreate, skipDuplicates: true });
      created = toCreate.length;
    }
    const skipped = uniqueNames.length - toCreate.length;

    // 4. Fetch all brands (including newly created) and link products in bulk
    const allBrands = await prisma.brand.findMany({ where: { isDeleted: false }, select: { id: true, name: true } });
    // Use a single raw update per brand — much faster
    for (const brand of allBrands) {
      await prisma.product.updateMany({
        where: { brand: brand.name, brandId: null, isDeleted: false },
        data: { brandId: brand.id },
      });
    }

    return { created, skipped, total: uniqueNames.length };
  },

  // ── CATEGORIES ───────────────────────────────────────────────────────────
  createCategory(input: { name: string; parentId?: string }, actor: Actor) {
    return prisma.productCategory.create({ data: { ...input, createdBy: actor.id } });
  },

  listCategories() {
    return prisma.productCategory.findMany({
      where: { isDeleted: false },
      include: { children: { where: { isDeleted: false }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  },

  // Deduplicate PRODUCTS by EAN — merges leftover duplicate rows (e.g. from
  // earlier bugs where the same EAN ended up as 2+ rows, including soft-deleted
  // "ghosts"). Keeps the most-recently-updated ACTIVE row per EAN; soft-deletes
  // the rest. Safe to run repeatedly — it's a no-op once data is clean.
  async deduplicateProductsByEan(actor: Actor) {
    const all = await prisma.product.findMany({
      select: { id: true, ean: true, isDeleted: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const byEan = new Map<string, typeof all>();
    for (const p of all) {
      const key = p.ean.trim();
      if (!key) continue;
      if (!byEan.has(key)) byEan.set(key, []);
      byEan.get(key)!.push(p);
    }
    const toDeleteIds: string[] = [];
    for (const group of byEan.values()) {
      if (group.length <= 1) continue;
      const active = group.filter(g => !g.isDeleted);
      const keep = (active.length ? active : group)[0]; // list is already sorted by updatedAt desc
      for (const g of group) if (g.id !== keep.id) toDeleteIds.push(g.id);
    }
    if (toDeleteIds.length) {
      await prisma.product.updateMany({
        where: { id: { in: toDeleteIds } },
        data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
      });
    }
    return { merged: toDeleteIds.length };
  },

  // Deduplicate categories — merges duplicates (same name) into one
  async deduplicateCategories() {
    const all = await prisma.productCategory.findMany({ where: { isDeleted: false }, orderBy: { createdAt: 'asc' } });
    const seen = new Map<string, string>(); // name -> first id
    const toDelete: string[] = [];
    for (const cat of all) {
      const key = cat.name.toLowerCase().trim();
      if (seen.has(key)) {
        // Move products from duplicate to original
        await prisma.product.updateMany({ where: { categoryId: cat.id }, data: { categoryId: seen.get(key)! } });
        toDelete.push(cat.id);
      } else {
        seen.set(key, cat.id);
      }
    }
    if (toDelete.length) {
      await prisma.productCategory.updateMany({ where: { id: { in: toDelete } }, data: { isDeleted: true } });
    }
    return { deduplicated: toDelete.length, remaining: seen.size };
  },

  async updateCategory(id: string, input: { name: string; parentId?: string }, actor: Actor) {
    return prisma.productCategory.update({ where: { id }, data: { ...input, updatedBy: actor.id } });
  },

  // CSV bulk import for categories — same ADD/UPDATE/DELETE Action convention as brands.
  // Matching is case-insensitive + trimmed to avoid spawning near-duplicates.
  async bulkImportCategories(rows: { name: string; action?: string }[], actor: Actor) {
    let created = 0, updated = 0, deleted = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row.name || '').trim();
      if (!name) { errors.push('Empty name skipped'); continue; }
      const action = (row.action || 'ADD').toUpperCase().trim();
      try {
        const existing = await prisma.productCategory.findFirst({
          where: { name: { equals: name, mode: 'insensitive' }, isDeleted: false },
        });
        if (action === 'DELETE') {
          if (existing) {
            await prisma.productCategory.update({
              where: { id: existing.id },
              data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
            });
            deleted++;
          }
        } else if (action === 'UPDATE' || existing) {
          if (existing) {
            await prisma.productCategory.update({ where: { id: existing.id }, data: { name, updatedBy: actor.id } });
            updated++;
          } else {
            await prisma.productCategory.create({ data: { name, createdBy: actor.id } });
            created++;
          }
        } else {
          await prisma.productCategory.create({ data: { name, createdBy: actor.id } });
          created++;
        }
      } catch (e: any) { errors.push(`${name}: ${e.message?.slice(0, 50)}`); }
    }
    return { created, updated, deleted, errors: errors.slice(0, 20), totalErrors: errors.length };
  },

  async deleteCategory(id: string, actor: Actor) {
    return prisma.productCategory.update({
      where: { id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
    });
  },

  // ── ATTRIBUTES ───────────────────────────────────────────────────────────
  async setAttributes(productId: string, attributes: { key: string; value: string }[], actor: Actor) {
    const product = await productRepository.findById(productId);
    if (!product) throw new NotFoundError('Product not found');
    return prisma.$transaction(async (tx) => {
      for (const attr of attributes) {
        await tx.productAttribute.upsert({
          where: { productId_key: { productId, key: attr.key } },
          update: { value: attr.value, updatedAt: new Date() },
          create: { productId, key: attr.key, value: attr.value },
        });
      }
      return tx.productAttribute.findMany({ where: { productId } });
    });
  },

  // ── SAVED VIEWS ──────────────────────────────────────────────────────────
  listSavedViews(userId: string) {
    return prisma.savedView.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  },

  createSavedView(userId: string, input: { name: string; filters: any; columns: any; sortBy?: string; sortDir?: string }) {
    return prisma.savedView.create({ data: { userId, ...input } });
  },

  updateSavedView(id: string, userId: string, input: any) {
    return prisma.savedView.update({ where: { id }, data: { ...input, updatedAt: new Date() } });
  },

  deleteSavedView(id: string, userId: string) {
    return prisma.savedView.delete({ where: { id } });
  },
};
