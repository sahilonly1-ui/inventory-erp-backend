import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

// Safe includes that work even if brands/attributes tables don't exist yet
const SAFE_INCLUDE = {
  category: true,
  vendor: true,
  stockLevels: { include: { warehouse: true } },
} as const;

// Full includes — only used after DB migration has run
const FULL_INCLUDE = {
  ...SAFE_INCLUDE,
  brandRef: true,
  attributes: true,
} as const;

async function safeInclude() {
  // Try full include first; fall back to safe if new tables don't exist
  try {
    await prisma.brand.findFirst();
    return FULL_INCLUDE;
  } catch {
    return SAFE_INCLUDE;
  }
}

export const productRepository = {
  async findById(id: string) {
    const inc = await safeInclude();
    return prisma.product.findFirst({
      where: { id, isDeleted: false },
      include: inc as any,
    });
  },

  findByEan(ean: string) {
    return prisma.product.findFirst({ where: { ean, isDeleted: false } });
  },

  async list(params: {
    search?: string; brand?: string | string[]; brandId?: string | string[];
    categoryId?: string | string[]; vendorId?: string | string[];
    warehouseId?: string; imeiRequired?: boolean; status?: string | string[];
    costPriceMin?: number; costPriceMax?: number;
    sellingPriceMin?: number; sellingPriceMax?: number;
    createdFrom?: string; createdTo?: string;
    lowStock?: boolean; outOfStock?: boolean; withStock?: boolean;
    skip: number; take: number;
    sortBy?: string; sortDir?: 'asc' | 'desc';
  }) {
    const toArr = (v: string | string[] | undefined) =>
      v ? (Array.isArray(v) ? v : [v]) : undefined;

    const brands    = toArr(params.brand);
    const brandIds  = toArr(params.brandId);
    const catIds    = toArr(params.categoryId);
    const vendorIds = toArr(params.vendorId);
    const statuses  = toArr(params.status);

    // '__blank__' is a special filter value meaning "no brand" or "no category"
    const blankBrand = brands?.includes('__blank__');
    const blankCat   = catIds?.includes('__blank__');
    const realBrands = brands?.filter(b => b !== '__blank__');
    const realCatIds = catIds?.filter(c => c !== '__blank__');

    const where: Prisma.ProductWhereInput = {
      isDeleted: false,
      ...(blankBrand
        ? { brand: '' }
        : realBrands?.length ? { brand: { in: realBrands } } : {}),
      ...(brandIds?.length  ? { brandId:    { in: brandIds }            } : {}),
      ...(blankCat
        ? { categoryId: { equals: null } }
        : realCatIds?.length ? { categoryId: { in: realCatIds } } : {}),
      ...(vendorIds?.length ? { vendorId:   { in: vendorIds }           } : {}),
      ...(statuses?.length  ? { status:     { in: statuses as any }     } : {}),
      ...(params.imeiRequired !== undefined ? { imeiRequired: params.imeiRequired } : {}),
      ...(params.costPriceMin    !== undefined || params.costPriceMax    !== undefined
        ? { costPrice:    { gte: params.costPriceMin,    lte: params.costPriceMax }    } : {}),
      ...(params.sellingPriceMin !== undefined || params.sellingPriceMax !== undefined
        ? { sellingPrice: { gte: params.sellingPriceMin, lte: params.sellingPriceMax } } : {}),
      ...(params.createdFrom || params.createdTo
        ? { createdAt: {
            gte: params.createdFrom ? new Date(params.createdFrom) : undefined,
            lte: params.createdTo   ? new Date(params.createdTo)   : undefined,
          }} : {}),
      ...(params.search ? (() => {
        const words = params.search.trim().split(/\s+/).filter(Boolean);
        if (words.length <= 1) {
          return { OR: [
            { ean:   { contains: params.search } },
            { model: { contains: params.search, mode: 'insensitive' } },
            { brand: { contains: params.search, mode: 'insensitive' } },
            { description: { contains: params.search, mode: 'insensitive' } },
            { vendor:   { name: { contains: params.search, mode: 'insensitive' } } },
            { category: { name: { contains: params.search, mode: 'insensitive' } } },
            { imeiUnits: { some: { imei1: { contains: params.search } } } },
          ]};
        }
        // Multi-word: ALL words must match somewhere in the product fields
        return { AND: words.map((w: string) => ({ OR: [
          { ean:   { contains: w } },
          { model: { contains: w, mode: 'insensitive' } },
          { brand: { contains: w, mode: 'insensitive' } },
          { description: { contains: w, mode: 'insensitive' } },
          { vendor:   { name: { contains: w, mode: 'insensitive' } } },
          { category: { name: { contains: w, mode: 'insensitive' } } },
        ]}))};
      })() : {}),
      ...(params.outOfStock ? { stockLevels: { none:  { quantity: { gt: 0 } } } } : {}),
      ...((params as any).withStock ? { stockLevels: { some:  { quantity: { gt: 0 } } } } : {}),
      ...(params.warehouseId ? { stockLevels: { some: { warehouseId: params.warehouseId } } } : {}),
    };

    const sf = params.sortBy || 'createdAt';
    const sd = params.sortDir || 'desc';
    // 'stock' cannot be sorted via Prisma relation — fall back to updatedAt
    const primaryOrderBy: Prisma.ProductOrderByWithRelationInput =
      sf === 'vendor'   ? { vendor:   { name: sd } } :
      sf === 'category' ? { category: { name: sd } } :
      sf === 'brand'    ? { brand: sd }               :
      sf === 'stock'    ? { updatedAt: sd }           :
      ['model','ean','costPrice','sellingPrice','gstRate','createdAt','updatedAt'].includes(sf)
        ? { [sf]: sd } : { createdAt: sd };

    // CRITICAL: add 'id' as a deterministic secondary sort key. Bulk operations
    // (import, bulk update) set updatedAt/createdAt to the exact same timestamp
    // for thousands of rows in one statement. Sorting on that field ALONE gives
    // Postgres no stable tie-break order — paginating with skip/take across
    // separate requests (as CSV export does) can then return the same tied row
    // on two different pages while skipping another entirely. 'id' is unique,
    // so appending it as a tie-breaker makes the full ordering deterministic
    // and pagination/export 100% reliable regardless of how many rows tie.
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = [primaryOrderBy, { id: 'asc' }];

    const inc = await safeInclude();

    // Stock sort requires in-memory sort (Prisma can't SUM a relation in orderBy)
    if (sf === 'stock') {
      const [allItems, total] = await prisma.$transaction([
        prisma.product.findMany({
          where,
          orderBy: { id: 'asc' }, // stable base order before the in-memory qty sort below —
                                    // without this, Postgres can return rows in a different
                                    // order on each separate call, shuffling tied-quantity rows
                                    // across export pages (same bug class as the main sort fix).
          select: { id: true, stockLevels: { select: { quantity: true } } },
        }),
        prisma.product.count({ where }),
      ]);
      const sorted = allItems
        .map(p => ({ id: p.id, qty: p.stockLevels.reduce((s: number, l: any) => s + l.quantity, 0) }))
        .sort((a, b) => sd === 'desc' ? b.qty - a.qty : a.qty - b.qty);
      const pageIds = sorted.slice(params.skip, params.skip + params.take).map(p => p.id);
      const fullItems = await prisma.product.findMany({
        where: { id: { in: pageIds } },
        include: inc as any,
      });
      // Preserve sort order
      const ordered = pageIds.map(id => fullItems.find((p: any) => p.id === id)).filter(Boolean);
      return [ordered, total] as any;
    }

    return prisma.$transaction([
      prisma.product.findMany({ where, orderBy, skip: params.skip, take: params.take, include: inc as any }),
      prisma.product.count({ where }),
    ]);
  },

  async bulkUpdate(ids: string[], data: Prisma.ProductUncheckedUpdateManyInput) {
    return prisma.product.updateMany({
      where: { id: { in: ids }, isDeleted: false }, data,
    });
  },

  async getStats() {
    const [total, active, withStock, noStock] = await prisma.$transaction([
      prisma.product.count({ where: { isDeleted: false } }),
      prisma.product.count({ where: { isDeleted: false, status: 'ACTIVE' } }),
      prisma.product.count({ where: { isDeleted: false, stockLevels: { some: { quantity: { gt: 0 } } } } }),
      prisma.product.count({ where: { isDeleted: false, stockLevels: { none: { quantity: { gt: 0 } } } } }),
    ]);
    const lowStock = withStock; // products with some stock (could refine with minStock)
    return { total, active, lowStock, outOfStock: noStock };
  },
};
