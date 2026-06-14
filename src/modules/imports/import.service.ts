import ExcelJS from 'exceljs';
import { ImportType, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { BadRequestError } from '../../common/errors';
import { applyLedgerMovementTx } from '../inventory/inventory.service';
import { imeiRepository } from '../imei/imei.repository';
import { assertConsistentTx } from '../inventory/reconciliation.service';
import {
  normalizeHeader, PRODUCT_ALIASES, VENDOR_ALIASES, STOCK_ALIASES, IMEI_ALIASES,
  productRowSchema, vendorRowSchema, stockRowSchema, imeiRowSchema,
} from './import.maps';

interface Actor { id: string; ip: string | null }
interface RowError { row: number; errors: unknown }

const ALIASES: Record<ImportType, Record<string, string>> = {
  [ImportType.PRODUCTS]: PRODUCT_ALIASES,
  [ImportType.VENDORS]: VENDOR_ALIASES,
  [ImportType.STOCK_IN]: STOCK_ALIASES,
  [ImportType.STOCK_OUT]: STOCK_ALIASES,
  [ImportType.IMEI]: IMEI_ALIASES,
};

// Parse the first worksheet into objects keyed by canonical field names.
function parseSheet(buffer: Buffer, aliases: Record<string, string>): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.load(buffer).then(() => {
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestError('Workbook has no sheets');
    const headerRow = ws.getRow(1);
    const colField: Record<number, string> = {};
    headerRow.eachCell((cell, col) => {
      const field = aliases[normalizeHeader(String(cell.value ?? ''))];
      if (field) colField[col] = field;
    });
    const rows: Record<string, unknown>[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj: Record<string, unknown> = {};
      let hasValue = false;
      row.eachCell((cell, col) => {
        const field = colField[col];
        if (!field) return;
        const v = cell.value;
        obj[field] = typeof v === 'object' && v !== null && 'text' in v ? (v as { text: string }).text : v;
        if (obj[field] !== null && obj[field] !== undefined && obj[field] !== '') hasValue = true;
      });
      if (hasValue) rows.push(obj);
    });
    return rows;
  });
}

export const importService = {
  async run(type: ImportType, fileName: string, buffer: Buffer, actor: Actor) {
    const log = await prisma.importLog.create({ data: { type, fileName, status: 'VALIDATING', importedBy: actor.id } });
    const raw = await parseSheet(buffer, ALIASES[type]);

    const errors: RowError[] = [];
    let success = 0;

    for (let i = 0; i < raw.length; i++) {
      const rowNo = i + 2; // sheet row (1 = header)
      try {
        await applyRow(type, raw[i], rowNo, actor);
        success++;
      } catch (e) {
        errors.push({ row: rowNo, errors: e instanceof Error ? e.message : e });
      }
    }

    const status = success === 0 ? 'REJECTED' : errors.length ? 'PARTIAL' : 'COMPLETED';
    await prisma.importLog.update({
      where: { id: log.id },
      data: { status, totalRows: raw.length, successRows: success, failedRows: errors.length, errors: errors as object },
    });

    return { importId: log.id, type, total: raw.length, success, failed: errors.length, status, errors: errors.slice(0, 100) };
  },
};

async function applyRow(type: ImportType, row: Record<string, unknown>, _rowNo: number, actor: Actor): Promise<void> {
  switch (type) {
    case ImportType.PRODUCTS: {
      const data = productRowSchema.parse(row);
      const exists = await prisma.product.findFirst({ where: { isDeleted: false, OR: [{ ean: data.ean }, { sku: data.sku }] } });
      if (exists) throw new Error('duplicate EAN/SKU');
      await prisma.product.create({ data: { ...data, createdBy: actor.id } });
      return;
    }
    case ImportType.VENDORS: {
      const data = vendorRowSchema.parse(row);
      const exists = await prisma.vendor.findFirst({ where: { code: data.code, isDeleted: false } });
      if (exists) throw new Error('duplicate vendor code');
      await prisma.vendor.create({ data: { ...data, createdBy: actor.id } });
      return;
    }
    case ImportType.STOCK_IN:
    case ImportType.STOCK_OUT: {
      const data = stockRowSchema.parse(row);
      const product = await prisma.product.findFirst({ where: { ean: data.ean, isDeleted: false } });
      if (!product) throw new Error(`unknown EAN ${data.ean}`);
      if (product.imeiRequired) throw new Error('IMEI product — use IMEI import');
      const warehouse = await prisma.warehouse.findFirst({ where: { code: data.warehouseCode, isDeleted: false } });
      if (!warehouse) throw new Error(`unknown warehouse ${data.warehouseCode}`);
      const t = type === ImportType.STOCK_IN ? TransactionType.STOCK_IN : TransactionType.STOCK_OUT;
      const signed = type === ImportType.STOCK_IN ? data.quantity : -data.quantity;
      await prisma.$transaction((tx) =>
        applyLedgerMovementTx(tx, {
          productId: product.id, warehouseId: warehouse.id, type: t, signedQty: signed,
          unitCost: data.unitCost ?? null, referenceType: 'IMPORT',
        }, actor),
      );
      return;
    }
    case ImportType.IMEI: {
      const data = imeiRowSchema.parse(row);
      const product = await prisma.product.findFirst({ where: { ean: data.ean, isDeleted: false } });
      if (!product) throw new Error(`unknown EAN ${data.ean}`);
      if (!product.imeiRequired) throw new Error('product is not IMEI-tracked');
      const warehouse = await prisma.warehouse.findFirst({ where: { code: data.warehouseCode, isDeleted: false } });
      if (!warehouse) throw new Error(`unknown warehouse ${data.warehouseCode}`);
      await prisma.$transaction(async (tx) => {
        await imeiRepository.createReceived(tx, product.id, warehouse.id, [{ imei1: data.imei1, imei2: data.imei2 ?? null }], actor.id);
        await applyLedgerMovementTx(tx, { productId: product.id, warehouseId: warehouse.id, type: TransactionType.STOCK_IN, signedQty: 1, referenceType: 'IMPORT' }, actor);
        await assertConsistentTx(tx, product.id, warehouse.id, true, { strict: true });
      });
      return;
    }
    default:
      throw new Error(`unsupported import type ${type}`);
  }
}
