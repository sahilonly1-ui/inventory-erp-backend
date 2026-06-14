import { z } from 'zod';
import { ReportType } from '@prisma/client';

export const reportTypeParam = z.object({ type: z.nativeEnum(ReportType) });

export const reportParamsSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  warehouseId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  lowStockThreshold: z.coerce.number().int().positive().default(5),
  deadStockDays: z.coerce.number().int().positive().default(90),
});

export type ReportParams = z.infer<typeof reportParamsSchema>;
