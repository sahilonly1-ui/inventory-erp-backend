import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { UnauthorizedError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { reportService } from './report.service';
import { reportTypeParam, reportParamsSchema } from './report.validator';

const router = Router();
router.use(authenticate);

// Custom IMEI type report (Open Box, Demo, Second IMEI, Swiped/Unswiped)
router.post('/imei_filtered', authorize(PERMISSIONS.REPORTS_VIEW), asyncHandler(async (req, res) => {
  const { imeiType, swiped, search } = req.body;
  // Build dynamic IMEI export
  const where: any = { isDeleted: false };
  if (imeiType && imeiType !== 'ALL') where.imeiType = imeiType;
  if (swiped === 'true') where.swiped = true;
  if (swiped === 'false') where.swiped = false;
  if (search) {
    const words = search.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      where.AND = words.map((w: string) => ({ OR: [
        { imei1: { contains: w } },
        { product: { model: { contains: w, mode: 'insensitive' } } },
        { product: { brand: { contains: w, mode: 'insensitive' } } },
      ]}));
    } else {
      where.OR = [
        { imei1: { contains: search } },
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
  ws.columns = [
    {header:'IMEI 1',key:'a',width:20},{header:'IMEI 2',key:'b',width:20},
    {header:'EAN',key:'c',width:16},{header:'Model',key:'d',width:32},
    {header:'Brand',key:'e',width:16},{header:'Type',key:'f',width:14},
    {header:'Status',key:'g',width:14},{header:'Swiped',key:'h',width:10},
    {header:'Supplier',key:'i',width:24},{header:'Warehouse',key:'j',width:18},
    {header:'Stock In Date',key:'k',width:20},{header:'Last Updated',key:'l',width:20},
  ];
  for (const r of rows) {
    ws.addRow({
      a:r.imei1, b:(r as any).imei2??'', c:r.product.ean, d:r.product.model,
      e:r.product.brand, f:(r as any).imeiType??'NIL', g:r.status,
      h:(r as any).swiped?'Yes':'No', i:(r as any).supplier?.name??'',
      j:r.warehouse.name, k:r.createdAt.toISOString().slice(0,10),
      l:r.updatedAt.toISOString().slice(0,10),
    });
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="IMEI_Export_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
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
