import ExcelJS from 'exceljs';
import { Prisma, ReportType, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { BadRequestError } from '../../common/errors';
import { ReportParams } from './report.validator';

interface Column { header: string; key: string; width?: number }
interface Dataset { sheet: string; columns: Column[]; rows: Record<string, unknown>[] }

const dateWhere = (p: ReportParams) =>
  p.from || p.to ? { createdAt: { ...(p.from ? { gte: p.from } : {}), ...(p.to ? { lte: p.to } : {}) } } : {};

// ---- per-type dataset builders -------------------------------------------
async function ledgerDataset(p: ReportParams, types: TransactionType[], sheet: string): Promise<Dataset> {
  const txns = await prisma.inventoryTransaction.findMany({
    where: {
      type: { in: types },
      ...(p.warehouseId ? { warehouseId: p.warehouseId } : {}),
      ...dateWhere(p),
    },
    include: { product: { select: { ean: true, sku: true, model: true, brand: true } }, warehouse: { select: { name: true } }, vendor: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50000,
  });
  return {
    sheet,
    columns: [
      { header: 'Date', key: 'date', width: 22 },
      { header: 'EAN', key: 'ean', width: 16 },
      { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Model', key: 'model', width: 24 },
      { header: 'Brand', key: 'brand', width: 16 },
      { header: 'Warehouse', key: 'warehouse', width: 18 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Unit Cost', key: 'unitCost', width: 12 },
      { header: 'Vendor', key: 'vendor', width: 18 },
    ],
    rows: txns.map((t) => ({
      date: t.createdAt.toISOString(),
      ean: t.product.ean, sku: t.product.sku, model: t.product.model, brand: t.product.brand,
      warehouse: t.warehouse.name, type: t.type, qty: t.quantity,
      unitCost: t.unitCost ? Number(t.unitCost) : '', vendor: t.vendor?.name ?? '',
    })),
  };
}

async function imeiDataset(): Promise<Dataset> {
  const rows = await prisma.imeiInventory.findMany({
    where: { isDeleted: false },
    include: { product: { select: { ean: true, model: true, brand: true } }, warehouse: { select: { name: true } } },
    take: 50000,
  });
  return {
    sheet: 'IMEI',
    columns: [
      { header: 'IMEI1', key: 'imei1', width: 20 }, { header: 'IMEI2', key: 'imei2', width: 20 },
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'Model', key: 'model', width: 24 },
      { header: 'Brand', key: 'brand', width: 16 }, { header: 'Warehouse', key: 'warehouse', width: 18 },
      { header: 'Status', key: 'status', width: 14 }, { header: 'Received', key: 'received', width: 22 },
    ],
    rows: rows.map((r) => ({
      imei1: r.imei1, imei2: r.imei2 ?? '', ean: r.product.ean, model: r.product.model,
      brand: r.product.brand, warehouse: r.warehouse.name, status: r.status, received: r.createdAt.toISOString(),
    })),
  };
}

async function valuationDataset(p: ReportParams): Promise<Dataset> {
  const levels = await prisma.stockLevel.findMany({
    where: { quantity: { gt: 0 }, ...(p.warehouseId ? { warehouseId: p.warehouseId } : {}) },
    include: { product: { select: { ean: true, sku: true, model: true, costPrice: true, sellingPrice: true } }, warehouse: { select: { name: true } } },
    take: 100000,
  });
  return {
    sheet: 'Valuation',
    columns: [
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Model', key: 'model', width: 24 }, { header: 'Warehouse', key: 'warehouse', width: 18 },
      { header: 'Qty', key: 'qty', width: 10 }, { header: 'Cost Price', key: 'cost', width: 12 },
      { header: 'Stock Value', key: 'value', width: 14 },
    ],
    rows: levels.map((l) => ({
      ean: l.product.ean, sku: l.product.sku, model: l.product.model, warehouse: l.warehouse.name,
      qty: l.quantity, cost: Number(l.product.costPrice), value: Number(l.product.costPrice) * l.quantity,
    })),
  };
}

async function lowStockDataset(p: ReportParams): Promise<Dataset> {
  const levels = await prisma.stockLevel.findMany({
    where: { quantity: { lte: p.lowStockThreshold }, ...(p.warehouseId ? { warehouseId: p.warehouseId } : {}) },
    include: { product: { select: { ean: true, sku: true, model: true } }, warehouse: { select: { name: true } } },
    take: 100000,
  });
  return {
    sheet: 'Low Stock',
    columns: [
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Model', key: 'model', width: 24 }, { header: 'Warehouse', key: 'warehouse', width: 18 },
      { header: 'Qty', key: 'qty', width: 10 },
    ],
    rows: levels.map((l) => ({ ean: l.product.ean, sku: l.product.sku, model: l.product.model, warehouse: l.warehouse.name, qty: l.quantity })),
  };
}

async function deadStockDataset(p: ReportParams): Promise<Dataset> {
  // qty>0 with no outbound movement within deadStockDays.
  const rows = await prisma.$queryRaw<
    { ean: string; sku: string; model: string; warehouse: string; qty: number; lastOut: Date | null }[]
  >`
    SELECT pr.ean, pr.sku, pr.model, w.name AS warehouse, sl.quantity AS qty,
           (SELECT MAX(it."createdAt") FROM inventory_transactions it
             WHERE it."productId" = sl."productId" AND it."warehouseId" = sl."warehouseId"
               AND it.type IN ('STOCK_OUT','MARKETPLACE_DISPATCH','TRANSFER_OUT')) AS "lastOut"
    FROM stock_levels sl
    JOIN products pr ON pr.id = sl."productId"
    JOIN warehouses w ON w.id = sl."warehouseId"
    WHERE sl.quantity > 0
      ${p.warehouseId ? Prisma.sql`AND sl."warehouseId" = ${p.warehouseId}` : Prisma.empty}
    `;
  const cutoff = Date.now() - p.deadStockDays * 86_400_000;
  const dead = rows.filter((r) => !r.lastOut || new Date(r.lastOut).getTime() < cutoff);
  return {
    sheet: 'Dead Stock',
    columns: [
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Model', key: 'model', width: 24 }, { header: 'Warehouse', key: 'warehouse', width: 18 },
      { header: 'Qty', key: 'qty', width: 10 }, { header: 'Last Outbound', key: 'lastOut', width: 22 },
    ],
    rows: dead.map((r) => ({ ean: r.ean, sku: r.sku, model: r.model, warehouse: r.warehouse, qty: r.qty, lastOut: r.lastOut ? new Date(r.lastOut).toISOString() : 'never' })),
  };
}

async function vendorDataset(p: ReportParams): Promise<Dataset> {
  const txns = await prisma.inventoryTransaction.findMany({
    where: { vendorId: p.vendorId ?? undefined, quantity: { gt: 0 }, ...dateWhere(p) },
    include: { vendor: { select: { name: true, code: true } }, product: { select: { ean: true, model: true } } },
    take: 50000,
  });
  return {
    sheet: 'Vendor',
    columns: [
      { header: 'Vendor', key: 'vendor', width: 20 }, { header: 'Code', key: 'code', width: 14 },
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'Model', key: 'model', width: 24 },
      { header: 'Qty In', key: 'qty', width: 10 }, { header: 'Date', key: 'date', width: 22 },
    ],
    rows: txns.map((t) => ({ vendor: t.vendor?.name ?? '', code: t.vendor?.code ?? '', ean: t.product.ean, model: t.product.model, qty: t.quantity, date: t.createdAt.toISOString() })),
  };
}

async function marketplaceDataset(p: ReportParams): Promise<Dataset> {
  const orders = await prisma.marketplaceOrder.findMany({
    where: { isDeleted: false, ...dateWhere(p) }, include: { items: true }, take: 50000,
  });
  const rows: Record<string, unknown>[] = [];
  for (const o of orders) for (const it of o.items) {
    rows.push({ marketplace: o.marketplace, orderNumber: o.orderNumber, status: o.status, sku: it.sku, ean: it.ean, qty: it.quantity, imei: it.imei ?? '', date: o.createdAt.toISOString() });
  }
  return {
    sheet: 'Marketplace',
    columns: [
      { header: 'Marketplace', key: 'marketplace', width: 16 }, { header: 'Order #', key: 'orderNumber', width: 20 },
      { header: 'Status', key: 'status', width: 14 }, { header: 'SKU', key: 'sku', width: 16 },
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'Qty', key: 'qty', width: 8 },
      { header: 'IMEI', key: 'imei', width: 20 }, { header: 'Date', key: 'date', width: 22 },
    ],
    rows,
  };
}

async function openBoxDataset(): Promise<Dataset> {
  const rows = await prisma.openBoxInventory.findMany({ where: { isDeleted: false }, include: { product: { select: { ean: true, model: true } } }, take: 50000 });
  return {
    sheet: 'Open Box',
    columns: [
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'Model', key: 'model', width: 24 },
      { header: 'IMEI', key: 'imei', width: 20 }, { header: 'Grade', key: 'grade', width: 8 },
      { header: 'Notes', key: 'notes', width: 30 },
    ],
    rows: rows.map((r) => ({ ean: r.product.ean, model: r.product.model, imei: r.imei ?? '', grade: r.grade, notes: r.remarks ?? '' })),
  };
}

async function profitDataset(p: ReportParams): Promise<Dataset> {
  // margin on outbound (sales) movements over the period
  const txns = await prisma.inventoryTransaction.findMany({
    where: { type: { in: [TransactionType.STOCK_OUT, TransactionType.MARKETPLACE_DISPATCH] }, ...dateWhere(p) },
    include: { product: { select: { ean: true, model: true, costPrice: true, sellingPrice: true } } },
    take: 50000,
  });
  return {
    sheet: 'Profit',
    columns: [
      { header: 'EAN', key: 'ean', width: 16 }, { header: 'Model', key: 'model', width: 24 },
      { header: 'Units Sold', key: 'units', width: 12 }, { header: 'Cost', key: 'cost', width: 12 },
      { header: 'Selling', key: 'selling', width: 12 }, { header: 'Profit', key: 'profit', width: 14 },
    ],
    rows: txns.map((t) => {
      const units = Math.abs(t.quantity);
      const cost = Number(t.product.costPrice); const selling = Number(t.product.sellingPrice);
      return { ean: t.product.ean, model: t.product.model, units, cost, selling, profit: (selling - cost) * units };
    }),
  };
}

async function buildDataset(type: ReportType, p: ReportParams): Promise<Dataset> {
  switch (type) {
    case ReportType.STOCK_IN: return ledgerDataset(p, [TransactionType.STOCK_IN, TransactionType.OPENING], 'Stock In');
    case ReportType.STOCK_OUT: return ledgerDataset(p, [TransactionType.STOCK_OUT, TransactionType.MARKETPLACE_DISPATCH, TransactionType.TRANSFER_OUT], 'Stock Out');
    case ReportType.IMEI: return imeiDataset();
    case ReportType.INVENTORY_VALUATION: return valuationDataset(p);
    case ReportType.LOW_STOCK: return lowStockDataset(p);
    case ReportType.DEAD_STOCK: return deadStockDataset(p);
    case ReportType.VENDOR: return vendorDataset(p);
    case ReportType.MARKETPLACE: return marketplaceDataset(p);
    case ReportType.OPEN_BOX: return openBoxDataset();
    case ReportType.PROFIT: return profitDataset(p);
    default: throw new BadRequestError(`Unsupported report type ${type}`);
  }
}

export const reportService = {
  // Returns an xlsx buffer + filename and records a ReportExport row.
  async generate(type: ReportType, params: ReportParams, requestedBy: string): Promise<{ buffer: Buffer; filename: string }> {
    const dataset = await buildDataset(type, params);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Inventory ERP';
    wb.created = new Date();
    const ws = wb.addWorksheet(dataset.sheet);
    ws.columns = dataset.columns;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    dataset.rows.forEach((r) => ws.addRow(r));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dataset.columns.length } };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const filename = `${type.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    await prisma.reportExport.create({
      data: { type, status: 'COMPLETED', params: params as object, filePath: filename, requestedBy },
    });

    return { buffer, filename };
  },
};
