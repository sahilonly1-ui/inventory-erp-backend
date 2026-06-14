import { z } from 'zod';
import { TransactionType } from '@prisma/client';

const uuid = z.string().uuid();
const qty = z.coerce.number().int().positive();

export const stockInSchema = z.object({
  productId: uuid,
  warehouseId: uuid,
  quantity: qty,
  unitCost: z.coerce.number().nonnegative().optional(),
  vendorId: uuid.optional(),
  remarks: z.string().max(500).optional(),
});

export const stockOutSchema = z.object({
  productId: uuid,
  warehouseId: uuid,
  quantity: qty,
  remarks: z.string().max(500).optional(),
});

export const adjustSchema = z.object({
  productId: uuid,
  warehouseId: uuid,
  // signed: positive corrects up, negative corrects down. Must not be zero.
  quantity: z.coerce.number().int().refine((v) => v !== 0, 'quantity cannot be zero'),
  reason: z.string().min(3).max(500),
});

export const transferSchema = z
  .object({
    productId: uuid,
    fromWarehouseId: uuid,
    toWarehouseId: uuid,
    quantity: qty,
    imeis: z.array(z.string().regex(/^\d{14,17}$/)).optional(),
    remarks: z.string().max(500).optional(),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: 'Source and destination warehouses must differ',
    path: ['toWarehouseId'],
  });

export const stockQuerySchema = z.object({
  productId: uuid.optional(),
  warehouseId: uuid.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const ledgerQuerySchema = z.object({
  productId: uuid.optional(),
  warehouseId: uuid.optional(),
  type: z.nativeEnum(TransactionType).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const reconcileSchema = z.object({
  productId: uuid.optional(),
  warehouseId: uuid.optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export const eanLookupSchema = z.object({ ean: z.string().min(6).max(20) });
