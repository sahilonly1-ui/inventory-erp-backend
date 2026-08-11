import { z } from 'zod';
import { ImeiStatus } from '@prisma/client';

// Phones carry a 14-17 digit IMEI; tablets and Wi-Fi-only devices carry an
// alphanumeric serial number instead. Both are tracked in the same table so
// swipe/activation works identically for either.
const imei = z.string()
  .trim()
  .min(4, 'IMEI / Serial number is too short')
  .max(32, 'IMEI / Serial number is too long')
  .regex(/^[A-Za-z0-9-]+$/, 'IMEI / Serial number may only contain letters, digits and hyphens');

const imeiParam = z.string()
  .trim()
  .min(4)
  .max(32)
  .regex(/^[A-Za-z0-9-]+$/);

export const receiveImeiSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  imeis: z
    .array(z.object({
      imei1: imei,
      imei2: imei.optional(),
      imeiType: z.enum(['NIL','OPEN_BOX','DEMO','SECOND_IMEI']).default('NIL'),
    }))
    .min(1)
    .max(2000),
  vendorId: z.string().uuid().optional(),
  remarks: z.string().max(500).optional(),
  force: z.boolean().optional(), // bypass imeiRequired check (user explicitly chose IMEI column)
  type: z.enum(['STOCK_IN', 'OPENING']).optional(), // OPENING = Opening Stock entry, not a normal receive
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
  swiped: z.boolean().optional(),
});

export const imeiParamSchema = z.object({ imei: imeiParam });

export const imeiQuerySchema = z.object({
  status: z.nativeEnum(ImeiStatus).optional(),
  productId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  search: z.string().max(60).optional(),
  imeiType: z.enum(['NIL','OPEN_BOX','DEMO','SECOND_IMEI']).optional(),
  swiped:     z.enum(['true','false']).optional(),
  activated:  z.enum(['true','false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(50),
});
