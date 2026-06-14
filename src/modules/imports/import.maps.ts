import { z } from 'zod';
import { booleanish } from '../../common/zod';

// Header normalisation: lowercase, strip non-alphanumerics. Lets "Cost Price",
// "cost_price", "COSTPRICE" all map to the same field.
export const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '');

// alias -> canonical field
type AliasMap = Record<string, string>;

export const PRODUCT_ALIASES: AliasMap = {
  ean: 'ean', barcode: 'ean',
  sku: 'sku', code: 'sku',
  model: 'model', name: 'model',
  brand: 'brand', make: 'brand',
  costprice: 'costPrice', cost: 'costPrice', purchaseprice: 'costPrice',
  sellingprice: 'sellingPrice', price: 'sellingPrice', mrp: 'sellingPrice',
  gst: 'gstRate', gstrate: 'gstRate', tax: 'gstRate',
  hsn: 'hsnCode', hsncode: 'hsnCode',
  imeirequired: 'imeiRequired',
};

export const VENDOR_ALIASES: AliasMap = {
  name: 'name', vendor: 'name', vendorname: 'name',
  code: 'code', vendorcode: 'code',
  contact: 'contactPerson', contactperson: 'contactPerson',
  phone: 'phone', mobile: 'phone',
  email: 'email', gstin: 'gstin', address: 'address',
};

export const STOCK_ALIASES: AliasMap = {
  ean: 'ean', barcode: 'ean',
  warehouse: 'warehouseCode', warehousecode: 'warehouseCode',
  qty: 'quantity', quantity: 'quantity', count: 'quantity',
  cost: 'unitCost', unitcost: 'unitCost', costprice: 'unitCost',
};

export const IMEI_ALIASES: AliasMap = {
  ean: 'ean', barcode: 'ean',
  warehouse: 'warehouseCode', warehousecode: 'warehouseCode',
  imei: 'imei1', imei1: 'imei1',
  imei2: 'imei2',
};

export const productRowSchema = z.object({
  ean: z.string().min(6), sku: z.string().min(1), model: z.string().min(1), brand: z.string().min(1),
  costPrice: z.coerce.number().nonnegative().default(0),
  sellingPrice: z.coerce.number().nonnegative().default(0),
  gstRate: z.coerce.number().min(0).max(100).default(0),
  hsnCode: z.string().optional(),
  imeiRequired: booleanish.default(false),
});

export const vendorRowSchema = z.object({
  name: z.string().min(1), code: z.string().min(1),
  contactPerson: z.string().optional(), phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  gstin: z.string().optional(), address: z.string().optional(),
});

export const stockRowSchema = z.object({
  ean: z.string().min(6), warehouseCode: z.string().min(1),
  quantity: z.coerce.number().int().positive(), unitCost: z.coerce.number().nonnegative().optional(),
});

export const imeiRowSchema = z.object({
  ean: z.string().min(6), warehouseCode: z.string().min(1),
  imei1: z.string().regex(/^\d{14,17}$/), imei2: z.string().regex(/^\d{14,17}$/).optional(),
});
