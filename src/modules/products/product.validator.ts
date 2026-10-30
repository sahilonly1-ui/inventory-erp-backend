import { z } from 'zod';
import { booleanish } from '../../common/zod';

const money = z.coerce.number().nonnegative();
// Prices a product must have: blank / 0 is rejected so a product can't be saved without them.
const price = (label: string) => z.coerce.number({ invalid_type_error: `${label} is required` })
  .positive(`${label} is required and must be more than 0`);
const uuid  = z.string().uuid();
const arr   = (s: z.ZodTypeAny) => z.union([s, z.array(s)]).transform(v => Array.isArray(v) ? v : [v]).optional();

export const createProductSchema = z.object({
  ean:           z.string().trim().min(1, 'EAN / Barcode is required').max(30),
  model:         z.string().trim().min(1, 'Product Name is required').max(120),
  brand:         z.string().transform(v => v.replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim()).pipe(z.string().min(1, 'Brand is required').max(80)),
  brandId:       uuid.optional(),
  categoryId:    z.string({ required_error: 'Category is required' }).uuid('Category is required'),
  description:   z.string().max(1000).optional(),
  status:        z.enum(['ACTIVE','INACTIVE','DISCONTINUED','OPEN_BOX_ONLY','BLOCKED']).default('ACTIVE'),
  costPrice:     price('Cost Price'),
  sellingPrice:  price('MRP'),
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
  costPrice:   price('Cost Price').optional(),
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
  withStock:       booleanish.optional(),
  page:            z.coerce.number().int().positive().default(1),
  limit:           z.coerce.number().int().positive().max(2000).default(50),
  sortBy:          z.string().optional(),
  sortDir:         z.enum(['asc','desc']).default('desc'),
});

export const idParamSchema         = z.object({ id: z.string().uuid() });
export const createCategorySchema  = z.object({ name: z.string().min(1).max(120), parentId: uuid.optional() });
export const updateCategorySchema  = createCategorySchema.partial().refine(v => Object.keys(v).length > 0, 'No fields');
export const createBrandSchema     = z.object({ name: z.string().transform(v => v.replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim()).pipe(z.string().min(1).max(80)) });
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
