import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { PERMISSIONS } from '../../constants/permissions';
import * as svc from './specs.service';

const router = Router();
router.use(authenticate);

// Categories that currently have stock — the tab's single filter.
router.get('/categories', authorize(PERMISSIONS.PRODUCTS_READ), asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await svc.inStockCategories());
}));

// The sheet for one category. Also starts fetching any specs still missing.
router.get('/', authorize(PERMISSIONS.PRODUCTS_READ), asyncHandler(async (req: Request, res: Response) => {
  const categoryId = String(req.query.categoryId || '');
  if (!categoryId) throw new BadRequestError('categoryId is required');
  const data = await svc.sheet(categoryId);
  if (!data) throw new NotFoundError('Category not found');
  ok(res, data);
}));

// Price shown on the sheet (does not touch the product's cost price). null = back to cost price.
router.put('/price/:productId', authorize(PERMISSIONS.PRODUCTS_UPDATE), asyncHandler(async (req: Request, res: Response) => {
  const { price } = z.object({ price: z.coerce.number().positive().max(10_000_000).nullable() }).parse(req.body);
  await svc.setPrice(req.params.productId, price, req.user!.id);
  ok(res, { productId: req.params.productId, price });
}));

// Correct specs by hand.
router.put('/entry', authorize(PERMISSIONS.PRODUCTS_UPDATE), asyncHandler(async (req: Request, res: Response) => {
  const { key, specs } = z.object({ key: z.string().min(1), specs: z.record(z.string().max(240)) }).parse(req.body);
  const cleaned = Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  if (!(await svc.setSpecs(key, cleaned, req.user!.id))) throw new NotFoundError('Specs entry not found');
  ok(res, { key });
}));

// Fetch again — optionally from a website the user provides.
router.post('/refetch', authorize(PERMISSIONS.PRODUCTS_READ), asyncHandler(async (req: Request, res: Response) => {
  const { key, url } = z.object({ key: z.string().min(1), url: z.string().url().nullable().optional() }).parse(req.body);
  if (!(await svc.refetch(key, url ?? null))) throw new NotFoundError('Specs entry not found');
  ok(res, { key, queued: true });
}));

export default router;
