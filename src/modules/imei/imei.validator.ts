import { z } from 'zod';
import { ImeiStatus } from '@prisma/client';

const imei = z.string().regex(/^\d{14,17}$/, 'IMEI must be 14-17 digits');

export const receiveImeiSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  imeis: z
    .array(z.object({ imei1: imei, imei2: imei.optional() }))
    .min(1)
    .max(2000),
  remarks: z.string().max(500).optional(),
});

export const dispatchImeiSchema = z.object({
  imeis: z.array(imei).min(1).max(2000),
  channel: z.enum(['STOCK_OUT', 'MARKETPLACE']).default('STOCK_OUT'),
  referenceType: z.string().max(60).optional(),
  referenceId: z.string().max(120).optional(),
  remarks: z.string().max(500).optional(),
});

// Operator-driven transitions. Sales go through /dispatch, so SOLD is blocked here.
export const changeStatusSchema = z.object({
  status: z
    .nativeEnum(ImeiStatus)
    .refine((s) => s !== ImeiStatus.SOLD, 'Use /imei/dispatch to mark a unit SOLD'),
  reason: z.string().max(500).optional(),
});

export const imeiParamSchema = z.object({ imei: z.string().regex(/^\d{14,17}$/) });

export const imeiQuerySchema = z.object({
  status: z.nativeEnum(ImeiStatus).optional(),
  productId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  search: z.string().max(60).optional(),
  imeiType: z.enum(['NIL','OPEN_BOX','DEMO','SECOND_IMEI']).optional(),
  swiped: z.enum(['true','false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(50),
});
