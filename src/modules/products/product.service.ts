import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ConflictError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { productRepository } from './product.repository';

interface Actor { id: string; ip: string | null; }

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

  // Bulk import — high-performance batch upsert by EAN
  async bulkImport(rows: any[], actor: Actor) {
    // Only keep valid Prisma Product fields — strip frontend-only fields (_category, _orig, etc.)
    const ALLOWED = new Set(['ean','model','brand','brandId','categoryId','vendorId',
      'status','costPrice','sellingPrice','gstRate','hsnCode','description',
      'imeiRequired','serialRequired','minStock']);

    const sanitize = (row: any) => {
      const clean: any = {};
      for (const key of ALLOWED) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
          clean[key] = row[key];
        }
      }
      return clean;
    };

    // Filter valid rows
    const validRows = rows
      .filter(r => r.ean && r.model)
      .map(r => ({ ...sanitize(r), ean: String(r.ean).trim(), model: String(r.model).trim() }));

    if (!validRows.length) return { created: 0, updated: 0, errors: ['No valid rows'], totalErrors: 1 };

    const errors: string[] = [];
    let created = 0, updated = 0;

    // Step 1: Find all existing products by EAN in ONE query
    const allEans = validRows.map(r => r.ean);
    const existing = await prisma.product.findMany({
      where: { ean: { in: allEans }, isDeleted: false },
      select: { id: true, ean: true },
    });
    const existingMap = new Map(existing.map(p => [p.ean, p.id]));

    const toCreate = validRows.filter(r => !existingMap.has(r.ean));
    const toUpdate = validRows.filter(r =>  existingMap.has(r.ean));

    // Step 2: Batch CREATE with createMany
    if (toCreate.length > 0) {
      try {
        const result = await prisma.product.createMany({
          data: toCreate.map(r => ({ ...r, sku: r.ean, createdBy: actor.id })),
          skipDuplicates: true,
        });
        created = result.count;
      } catch(e: any) {
        errors.push('Create batch error: ' + String(e.message).slice(0, 120));
      }
    }

    // Step 3: Batch UPDATE in chunks of 200 using $transaction
    const CHUNK = 200;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      try {
        await prisma.$transaction(
          chunk.map(row => {
            const id = existingMap.get(row.ean)!;
            const { ean, ...data } = row;
            return prisma.product.update({ where: { id }, data: { ...data, updatedBy: actor.id } });
          })
        );
        updated += chunk.length;
      } catch(e: any) {
        errors.push(`Update chunk ${i}-${i+chunk.length}: ${String(e.message).slice(0, 100)}`);
      }
    }

    return { created, updated, errors: errors.slice(0, 20), totalErrors: errors.length };
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
