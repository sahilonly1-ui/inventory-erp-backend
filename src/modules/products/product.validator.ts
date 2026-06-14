import { z } from 'zod';
import { booleanish } from '../../common/zod';

const money = z.coerce.number().nonnegative();

export const createProductSchema = z.object({
  ean: z.string().min(6).max(20),
  sku: z.string().min(1).max(60),
  model: z.string().min(1).max(120),
  brand: z.string().min(1).max(80),
  categoryId: z.string().uuid().optional(),
  description: z.string().max(1000).optional(),
  costPrice: money,
  sellingPrice: money,
  gstRate: z.coerce.number().min(0).max(100).default(0),
  hsnCode: z.string().max(20).optional(),
  vendorId: z.string().uuid().optional(),
  imeiRequired: booleanish.default(false),
  serialRequired: booleanish.default(false),
});

export const updateProductSchema = createProductSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'No fields to update',
);

export const listProductsSchema = z.object({
  search: z.string().max(120).optional(),
  brand: z.string().max(80).optional(),
  categoryId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  imeiRequired: booleanish.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export const createCategorySchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().optional(),
});
