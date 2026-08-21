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
  // Build dynamic IMEI export
  const where: any = { isDeleted: false };
  if (imeiType && imeiType !== 'ALL') where.imeiType = imeiType;
  if (status) where.status = status;
  if (swiped === 'true') where.swiped = true;
  if (swiped === 'false') where.swiped = false;
  if (activated === 'true') where.activated = true;
  if (activated === 'false') where.activated = false;
  if (brand) where.product = { brand: { equals: brand, mode: 'insensitive' } };
  if (search) {
    const words = search.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      where.AND = words.map((w: string) => ({ OR: [
        { imei1: { contains: w } },
        { product: { ean: { contains: w } } },
        { product: { model: { contains: w, mode: 'insensitive' } } },
        { product: { brand: { contains: w, mode: 'insensitive' } } },
      ]}));
    } else {
      where.OR = [
        { imei1: { contains: search } },
        { product: { ean: { contains: search } } },
        { product: { model: { contains: search, mode: 'insensitive' } } },
        { product: { brand: { contains: search, mode: 'insensitive' } } },
      ];
    }
  }
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
      swipedAt:    (r as any).swipedAt    ? new Date((r as any).swipedAt).toISOString().slice(0, 10) : '',
      activated:   (r as any).activated   ? 'Yes' : 'No',
      activatedAt: (r as any).activatedAt ? new Date((r as any).activatedAt).toISOString().slice(0, 10) : '',
      supplier:    (r as any).supplier?.name ?? '',
      stockIn:     r.createdAt.toISOString().slice(0, 10),
      updated:     r.updatedAt.toISOString().slice(0, 10),
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
