import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { UnauthorizedError, BadRequestError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { reportService } from './report.service';
import { reportTypeParam, reportParamsSchema } from './report.validator';

const router = Router();
router.use(authenticate);

// Custom IMEI type report (Open Box, Demo, Second IMEI, Swiped/Unswiped)
router.post('/imei_filtered', authorize(PERMISSIONS.REPORTS_EXPORT), asyncHandler(async (req, res) => {
  const { imeiType, swiped, activated, status, search, brand } = req.body;
  // Built as a list of AND-ed conditions rather than assigning where.OR/where.AND
  // directly in several places — this endpoint can receive imeiType, status and
  // search together (the IMEI Tracker's own Download XLSX sends all three at
  // once), and each used to write straight onto the same where.OR/where.AND key,
  // so whichever ran last silently discarded whatever an earlier one had set.
  const isDeleted = false;
  const conditions: any[] = [];

  if (imeiType && imeiType !== 'ALL') {
    // "OPEN_BOX" exists as a value in two unrelated fields: imeiType (set at
    // scan time — the unit was received as open-box stock) and status (set
    // later via Change Status — the unit was reclassified, e.g. after a
    // return). A unit can carry the label either way, and a report titled
    // "Open Box IMEIs" means "any unit that is open box" to the person
    // downloading it — not "only the ones recorded one particular way". Only
    // OPEN_BOX needs this: it is the one value that exists in both fields;
    // DEMO and SECOND_IMEI have no status-side equivalent to miss.
    if (imeiType === 'OPEN_BOX') {
      conditions.push({ OR: [{ imeiType: 'OPEN_BOX' }, { status: 'OPEN_BOX' }] });
    } else {
      conditions.push({ imeiType });
    }
  }
  if (status) conditions.push({ status });
  if (swiped === 'true') conditions.push({ swiped: true });
  if (swiped === 'false') conditions.push({ swiped: false });
  if (activated === 'true') conditions.push({ activated: true });
  if (activated === 'false') conditions.push({ activated: false });
  if (brand) conditions.push({ product: { brand: { equals: brand, mode: 'insensitive' } } });
  if (search) {
    const words = search.trim().split(/\s+/).filter(Boolean);
    const wordCondition = (w: string) => ({ OR: [
      { imei1: { contains: w } },
      { product: { ean: { contains: w } } },
      { product: { model: { contains: w, mode: 'insensitive' } } },
      { product: { brand: { contains: w, mode: 'insensitive' } } },
    ]});
    if (words.length > 1) conditions.push(...words.map(wordCondition));
    else conditions.push(wordCondition(words[0]));
  }

  const where: any = { isDeleted, ...(conditions.length ? { AND: conditions } : {}) };
  const { prisma } = await import('../../config/prisma');
  const rows = await prisma.imeiInventory.findMany({
    where,
    include: {
      product: { select: { ean: true, model: true, brand: true } },
      warehouse: { select: { name: true } },
      supplier: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100000,
  });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('IMEI Export');
  // Required columns only in specified order:
  const dmy = (d: Date) => {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  // All columns requested by the business
  ws.columns = [
    { header: 'EAN',              key: 'ean',         width: 16 },
    { header: 'IMEI / Serial',    key: 'imei',        width: 22 },
    { header: 'Model',            key: 'model',       width: 36 },
    { header: 'Brand',            key: 'brand',       width: 16 },
    { header: 'Status',           key: 'status',      width: 14 },
    { header: 'IMEI Type',        key: 'imeiType',    width: 14 },
    { header: 'Swiped',           key: 'swiped',      width: 10 },
    { header: 'Swiped On',        key: 'swipedAt',    width: 16 },
    { header: 'Activated',        key: 'activated',   width: 12 },
    { header: 'Activated On',     key: 'activatedAt', width: 16 },
    { header: 'Supplier',         key: 'supplier',    width: 24 },
    { header: 'Stock In Date',    key: 'stockIn',     width: 16 },
    { header: 'Last Updated',     key: 'updated',     width: 16 },
  ];
  for (const r of rows) {
    ws.addRow({
      ean:         r.product.ean,
      imei:        r.imei1,
      model:       r.product.model,
      brand:       r.product.brand,
      status:      r.status,
      imeiType:    (r as any).imeiType ?? '',
      swiped:      (r as any).swiped      ? 'Yes' : 'No',
      swipedAt:    (r as any).swipedAt    ? dmy(new Date((r as any).swipedAt)) : '',
      activated:   (r as any).activated   ? 'Yes' : 'No',
      activatedAt: (r as any).activatedAt ? dmy(new Date((r as any).activatedAt)) : '',
      supplier:    (r as any).supplier?.name ?? '',
      stockIn:     dmy(r.createdAt),
      updated:     dmy(r.updatedAt),
    });
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="IMEI_Export_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
}));

// Per-entry stock-in export: one workbook for a single vendor entry, named
// "<Vendor> - <Invoice No> - <Date>.xlsx".
router.post('/stock-in-entry', authorize(PERMISSIONS.REPORTS_EXPORT), asyncHandler(async (req: Request, res: Response) => {
  const ids: string[] = Array.isArray(req.body?.txnIds) ? req.body.txnIds.filter(Boolean) : [];
  if (!ids.length) throw new BadRequestError('txnIds is required');
  const { buildEntryExport } = await import('./entryExport.service');
  const { buffer, filename } = await buildEntryExport(ids);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

// Manually trigger the nightly per-vendor backup email (also runs on a cron).
// Useful for testing SMTP setup and for re-sending a day that failed.
router.post('/daily-backup', authorize(PERMISSIONS.REPORTS_EXPORT), asyncHandler(async (req: Request, res: Response) => {
  const date = String(req.body?.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const { sendDailyStockInBackup } = await import('./dailyBackup.service');
  const result = await sendDailyStockInBackup(date);
  res.json({ success: true, data: result });
}));

// POST /reports/:type  -> streams an xlsx download
router.post(
  '/:type',
  authorize(PERMISSIONS.REPORTS_EXPORT),
  validate(reportTypeParam, 'params'),
  validate(reportParamsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const { buffer, filename } = await reportService.generate(req.params.type as never, req.body, req.user.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

export default router;
