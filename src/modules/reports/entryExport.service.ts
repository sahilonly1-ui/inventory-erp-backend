import { prisma } from '../../config/prisma';

export interface EntryExportRow {
  productId: string;
  ean: string;
  model: string;
  code: string;      // IMEI, or serial number when the unit has no IMEI
  imeiType: string;
}

export interface EntryExport {
  buffer: Buffer;
  filename: string;
  vendorName: string;
  invoiceNo: string;
  dateLabel: string;
  rowCount: number;
}

// Filenames go into email attachments and Windows downloads, so strip anything
// those reject and collapse the runs of separators that leaves behind.
function safeFilePart(s: string): string {
  return (s || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Collect every unit received in one stock-in entry (a vendor + timestamp
 * grouping, matching how the dashboard groups transactions).
 *
 * Units that carry an IMEI report the IMEI; tablets and Wi-Fi devices carry a
 * serial number in the same column instead — they are stored in one table, so
 * a single column covers both without ambiguity.
 */
export async function buildEntryExport(txnIds: string[]): Promise<EntryExport> {
  const txns = await prisma.inventoryTransaction.findMany({
    where: { id: { in: txnIds } },
    include: {
      product: { select: { id: true, ean: true, model: true } },
      vendor: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!txns.length) throw new Error('No transactions found for this entry');

  const vendorName = txns.find(t => t.vendor?.name)?.vendor?.name || 'No Vendor';
  const stockedInAt = txns[0].createdAt;

  // Invoice numbers live on the IMEI rows; fall back to the transaction remarks
  // (which carry "Invoice: X" for non-IMEI entries).
  const productIds = [...new Set(txns.map(t => t.productId))];
  const windowStart = new Date(stockedInAt.getTime() - 60 * 60 * 1000);
  const windowEnd = new Date(stockedInAt.getTime() + 60 * 60 * 1000);

  // For Stock In entries the units were created in the window; for Stock Out
  // they were SOLD (status updated) in the window. Check both so the export
  // works correctly for either direction.
  const isOutbound = txns.every(t => t.quantity < 0);
  const units = await prisma.imeiInventory.findMany({
    where: {
      isDeleted: false,
      productId: { in: productIds },
      ...(isOutbound
        ? { status: 'SOLD', updatedAt: { gte: windowStart, lte: windowEnd } }
        : { createdAt: { gte: windowStart, lte: windowEnd } }),
    },
    include: { product: { select: { id: true, ean: true, model: true } } },
    orderBy: [{ product: { model: 'asc' } }, { imei1: 'asc' }],
  });

  const invoiceNo =
    units.find(u => (u as any).invoiceNo)?.['invoiceNo' as keyof typeof units[number]] as string ||
    (txns.find(t => t.remarks?.match(/Invoice:\s*([^|]+)/i))?.remarks?.match(/Invoice:\s*([^|]+)/i)?.[1] || '').trim() ||
    '';

  const rows: EntryExportRow[] = units.map(u => ({
    productId: u.productId,
    ean: u.product.ean,
    model: u.product.model,
    code: u.imei1,
    imeiType: (u as any).imeiType || 'NIL',
  }));

  // Products received without any unit-level code still belong on the sheet —
  // otherwise the export silently under-reports the entry.
  const codedByProduct = new Map<string, number>();
  for (const r of rows) codedByProduct.set(r.productId, (codedByProduct.get(r.productId) || 0) + 1);
  for (const t of txns) {
    const covered = codedByProduct.get(t.productId) || 0;
    const missing = Math.max(0, Math.abs(t.quantity) - covered);
    for (let i = 0; i < missing; i++) {
      rows.push({ productId: t.productId, ean: t.product.ean, model: t.product.model, code: '—', imeiType: 'NIL' });
    }
    if (missing > 0) codedByProduct.set(t.productId, covered + missing);
  }

  rows.sort((a, b) => a.model.localeCompare(b.model) || a.code.localeCompare(b.code));

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock In');

  ws.columns = [
    { header: 'Sr. No.',        key: 'sr',       width: 9 },
    { header: 'EAN',            key: 'ean',      width: 18 },
    { header: 'Product Name',   key: 'model',    width: 46 },
    { header: 'IMEI / Sr. No.', key: 'code',     width: 24 },
    { header: 'IMEI Type',      key: 'imeiType', width: 14 },
  ];

  // Title block above the table so the sheet stands alone as a record.
  ws.spliceRows(1, 0, [], [], [], []);
  ws.getCell('A1').value = 'iTechArena — Stock In Entry';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `Vendor: ${vendorName}`;
  ws.getCell('A3').value = `Invoice No: ${invoiceNo || '—'}`;
  ws.getCell('A4').value = `Date Stocked In: ${fmtDate(stockedInAt)}`;
  for (const ref of ['A2', 'A3', 'A4']) ws.getCell(ref).font = { size: 11 };

  const headerRow = ws.getRow(5);
  headerRow.values = ['Sr. No.', 'EAN', 'Product Name', 'IMEI / Sr. No.', 'IMEI Type'];
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    c.alignment = { vertical: 'middle', horizontal: 'left' };
  });

  rows.forEach((r, i) => {
    ws.addRow({ sr: i + 1, ean: r.ean, model: r.model, code: r.code, imeiType: r.imeiType });
  });

  // Keep long EANs and IMEIs as text so Excel doesn't render them in
  // scientific notation or strip leading zeros.
  ws.getColumn('ean').numFmt = '@';
  ws.getColumn('code').numFmt = '@';

  ws.views = [{ state: 'frozen', ySplit: 5 }];
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 5 } };

  const totalRow = ws.addRow({ sr: '', ean: '', model: `Total units: ${rows.length}`, code: '', imeiType: '' });
  totalRow.font = { bold: true };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);

  const parts = [safeFilePart(vendorName), safeFilePart(invoiceNo), fmtDate(stockedInAt)].filter(Boolean);
  const filename = `${parts.join(' - ')}.xlsx`;

  return { buffer, filename, vendorName, invoiceNo, dateLabel: fmtDate(stockedInAt), rowCount: rows.length };
}
