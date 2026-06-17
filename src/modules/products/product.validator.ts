import { z } from 'zod';
import { booleanish } from '../../common/zod';

const money = z.coerce.number().nonnegative();
const uuid  = z.string().uuid();
const arr   = (s: z.ZodTypeAny) => z.union([s, z.array(s)]).transform(v => Array.isArray(v) ? v : [v]).optional();

export const createProductSchema = z.object({
  ean:           z.string().min(1).max(30),
  model:         z.string().min(1).max(120),
  brand:         z.string().min(1).max(80),
  brandId:       uuid.optional(),
  categoryId:    uuid.optional(),
  description:   z.string().max(1000).optional(),
  status:        z.enum(['ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED']).default('ACTIVE'),
  costPrice:     money,
  sellingPrice:  money,
  gstRate:       z.coerce.number().min(0).max(100).default(0),
  hsnCode:       z.string().max(20).optional(),
  vendorId:      uuid.optional(),
  imeiRequired:  booleanish.default(false),
  serialRequired:booleanish.default(false),
  minStock:      z.coerce.number().int().nonnegative().default(0),
  images:        z.array(z.string()).default([]),
  attributes:    z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});

export const updateProductSchema = createProductSchema.partial().refine(
  v => Object.keys(v).length > 0, 'No fields to update'
);

export const bulkUpdateSchema = z.object({
  ids:         z.array(uuid).min(1),
  brand:       z.string().max(80).optional(),
  brandId:     uuid.optional(),
  categoryId:  uuid.optional(),
  vendorId:    uuid.optional(),
  status:      z.enum(['ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED']).optional(),
  costPrice:   money.optional(),
  sellingPrice:money.optional(),
  imeiRequired:booleanish.optional(),
  minStock:    z.coerce.number().int().nonnegative().optional(),
});

export const listProductsSchema = z.object({
  search:          z.string().max(120).optional(),
  brand:           arr(z.string()),
  brandId:         arr(uuid),
  categoryId:      arr(z.union([uuid, z.literal('__blank__')])),
  vendorId:        arr(uuid),
  warehouseId:     uuid.optional(),
  imeiRequired:    booleanish.optional(),
  status:          arr(z.enum(['ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED'])),
  costPriceMin:    z.coerce.number().optional(),
  costPriceMax:    z.coerce.number().optional(),
  sellingPriceMin: z.coerce.number().optional(),
  sellingPriceMax: z.coerce.number().optional(),
  createdFrom:     z.string().optional(),
  createdTo:       z.string().optional(),
  lowStock:        booleanish.optional(),
  outOfStock:      booleanish.optional(),
  page:            z.coerce.number().int().positive().default(1),
  limit:           z.coerce.number().int().positive().max(2000).default(50),
  sortBy:          z.string().optional(),
  sortDir:         z.enum(['asc','desc']).default('desc'),
});

export const idParamSchema         = z.object({ id: z.string().uuid() });
export const createCategorySchema  = z.object({ name: z.string().min(1).max(120), parentId: uuid.optional() });
export const updateCategorySchema  = createCategorySchema.partial().refine(v => Object.keys(v).length > 0, 'No fields');
export const createBrandSchema     = z.object({ name: z.string().min(1).max(80) });
export const updateBrandSchema     = createBrandSchema;
export const mergeBrandsSchema     = z.object({ sourceIds: z.array(uuid).min(1), targetId: uuid });
export const setAttributesSchema   = z.object({ attributes: z.array(z.object({ key: z.string(), value: z.string() })) });
export const savedViewSchema       = z.object({
  name:    z.string().min(1).max(80),
  filters: z.any(),
  columns: z.any(),
  sortBy:  z.string().optional(),
  sortDir: z.string().optional(),
});
