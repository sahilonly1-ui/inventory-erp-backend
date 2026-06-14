import { z } from 'zod';
import { Marketplace, MarketplaceOrderStatus } from '@prisma/client';

const item = z.object({
  sku: z.string().min(1),
  ean: z.string().min(6).max(20),
  quantity: z.coerce.number().int().positive(),
  imei: z.string().regex(/^\d{14,17}$/).optional(),
});

export const createOrdersSchema = z.object({
  orders: z
    .array(
      z.object({
        marketplace: z.nativeEnum(Marketplace),
        orderNumber: z.string().min(1).max(80),
        shipmentNumber: z.string().max(80).optional(),
        items: z.array(item).min(1),
      }),
    )
    .min(1)
    .max(1000),
});

export const dispatchSchema = z.object({ warehouseId: z.string().uuid() });

export const cancelSchema = z.object({ reason: z.string().max(500).optional() });

export const returnSchema = z.object({
  reason: z.string().max(500).optional(),
  items: z.array(z.object({ ean: z.string(), quantity: z.coerce.number().int().positive(), imei: z.string().optional() })).optional(),
});

export const listOrdersSchema = z.object({
  marketplace: z.nativeEnum(Marketplace).optional(),
  status: z.nativeEnum(MarketplaceOrderStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const orderIdParam = z.object({ id: z.string().uuid() });
