import { Prisma } from '@prisma/client';
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
      select: { brand: true, categoryId: true },
    });
    const brandNames  = [...new Set(toDelete.map(p => p.brand).filter(Boolean))];
    const categoryIds = [...new Set(toDelete.map(p => p.categoryId).filter(Boolean))] as string[];

    const result = await prisma.product.updateMany({
      where: { id: { in: ids }, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id },
    });

    const cascade = await cascadeCleanup(brandNames, categoryIds, actor);
    return { deleted: result.count, ...cascade };
  },

  // Delete ALL active products at once — cascades to empty brands/categories too
  async deleteAllProducts(actor: Actor) {
    const active = await prisma.product.findMany({
      where: { isDeleted: false },
      select: { brand: true, categoryId: true },
    });
    if (!active.length) return { deleted: 0, brandsRemoved: 0, categoriesRemoved: 0 };

    const brandNames  = [...new Set(active.map(p => p.brand).filter(Boolean))];
    const categoryIds = [...new Set(active.map(p => p.categoryId).filter(Boolean))] as string[];

    const result = await prisma.product.updateMany({
      where: { isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id },
    });

    const cascade = await cascadeCleanup(brandNames, categoryIds, actor);
    return { deleted: result.count, ...cascade };
  },

    // Bulk import — supports Action column: UPDATE (default, upsert) or DELETE
  async bulkImport(rows: any[], actor: Actor) {
    const VALID_STATUS = new Set(['ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED']);

    const normalized = rows.filter(r => r.ean).map(r => ({
      ean:          String(r.ean   || '').trim(),
      action:       String(r.action || 'UPDATE').trim().toUpperCase(), // UPDATE | DELETE
      model:        String(r.model || '').trim(),
      brand:        String(r.brand || ''),
      categoryId:   r.categoryId   || null,   // from CSV category→ID mapping
      status:       VALID_STATUS.has(String(r.status||'').toUpperCase()) ? String(r.status).toUpperCase() : 'ACTIVE',
      costPrice:    Number(r.costPrice)    || 0,
      sellingPrice: Number(r.sellingPrice) || 0,
      gstRate:      Number(r.gstRate)      || 18,
      hsnCode:      String(r.hsnCode || ''),
      minStock:     Number(r.minStock)     || 0,
    }));

    // ── DELETE rows: soft-delete by EAN, then cascade-clean empty brands/categories ──
    const deleteRows = normalized.filter(r => r.action === 'DELETE');
    let deletedCount = 0, brandsRemoved = 0, categoriesRemoved = 0;
    if (deleteRows.length) {
      const delEans = deleteRows.map(r => r.ean);
      const toDelete = await prisma.product.findMany({
        where: { ean: { in: delEans }, isDeleted: false },
        select: { id: true, brand: true, categoryId: true },
      });
      if (toDelete.length) {
        const delIds = toDelete.map(p => p.id);
        const delBrandNames  = [...new Set(toDelete.map(p => p.brand).filter(Boolean))];
        const delCategoryIds = [...new Set(toDelete.map(p => p.categoryId).filter(Boolean))] as string[];
        await prisma.product.updateMany({
          where: { id: { in: delIds } },
          data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id },
        });
        deletedCount = delIds.length;
        const cascade = await cascadeCleanup(delBrandNames, delCategoryIds, actor);
        brandsRemoved = cascade.brandsRemoved;
        categoriesRemoved = cascade.categoriesRemoved;
      }
    }

    // ── UPDATE rows (default action): upsert by EAN — requires model too ──
    const validRows = normalized.filter(r => r.action !== 'DELETE' && r.model);

    if (!validRows.length) {
      return { created: 0, updated: 0, deleted: deletedCount, brandsRemoved, categoriesRemoved, errors: deleteRows.length ? [] : ['No valid rows'], totalErrors: deleteRows.length ? 0 : 1 };
    }

    // Step 1: find existing EANs in ONE query
    const allEans = validRows.map(r => r.ean);
    const existing = await prisma.product.findMany({
      where: { ean: { in: allEans } },
      select: { ean: true },
    });
    const existingSet = new Set(existing.map(p => p.ean));
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
      } catch(e: any) { errors.push('Create error: ' + String(e.message).slice(0,150)); }
    }

    // Step 3: ONE raw SQL UPDATE for all existing products — every CSV column included
    if (toUpdate.length > 0) {
      try {
        const params: any[] = [];
        const valuesClauses: string[] = [];

        toUpdate.forEach(r => {
          const base = params.length;
          params.push(
            r.ean,                 // $1  ean (join key)
            r.model,                // $2  model
            r.brand,                 // $3  brand
            r.categoryId || null,    // $4  categoryId
            r.status,                // $5  status
            r.costPrice,              // $6  costPrice
            r.sellingPrice,            // $7  sellingPrice
            r.gstRate,                  // $8  gstRate
            r.hsnCode,                   // $9  hsnCode
            r.minStock,                   // $10 minStock
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
          WHERE products.ean = v.ean
        `;

        await prisma.$executeRawUnsafe(sql, ...params);
        updated = toUpdate.length;
      } catch(e: any) {
        errors.push('Update error: ' + String(e.message).slice(0,200));
      }
    }

    return { created, updated, deleted: deletedCount, brandsRemoved, categoriesRemoved, errors: errors.slice(0,20), totalErrors: errors.length };
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
      await writeAudit(tx, {
        userId: actor.id, action: 'UPDATE', entityName: 'products', entityId: id,
        oldValue: { brand: existing.brand, costPrice: existing.costPrice, sellingPrice: existing.sellingPrice },
        newValue: productData, ipAddress: actor.ip,
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
