import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { productService } from './product.service';
import {
  createProductSchema, updateProductSchema, listProductsSchema, idParamSchema,
  createCategorySchema, updateCategorySchema, createBrandSchema, updateBrandSchema,
  mergeBrandsSchema, setAttributesSchema, savedViewSchema, bulkUpdateSchema,
} from './product.validator';

const router = Router();
router.use(authenticate);
const actor = (req: Request) => ({ id: req.user!.id, ip: req.ip ?? null });

// ── IMPORTANT: All specific routes BEFORE /:id to avoid Express matching them as IDs ──

// ── BRANDS (must be before /:id) ──────────────────────────────────────────
router.get( '/brands/list',   authorize(PERMISSIONS.PRODUCTS_READ),   asyncHandler(async (_r, res) => ok(res, await productService.listBrands())));
router.post('/brands/bulk-import', authorize(PERMISSIONS.PRODUCTS_CREATE), asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if(!Array.isArray(rows)) throw new Error('rows must be an array');
  ok(res, await productService.bulkImportBrands(rows, actor(req)));
}));
router.post('/brands/sync',  authorize(PERMISSIONS.PRODUCTS_CREATE), asyncHandler(async (req, res) => ok(res, await productService.syncBrands(actor(req)))));
router.post('/brands/merge',  authorize(PERMISSIONS.PRODUCTS_UPDATE),  validate(mergeBrandsSchema), asyncHandler(async (req, res) => ok(res, await productService.mergeBrands(req.body.sourceIds, req.body.targetId, actor(req)))));
router.post('/brands',        authorize(PERMISSIONS.PRODUCTS_CREATE),  validate(createBrandSchema), asyncHandler(async (req, res) => ok(res, await productService.createBrand(req.body, actor(req)), 201)));
router.patch('/brands/:id',   authorize(PERMISSIONS.PRODUCTS_UPDATE),  validate(updateBrandSchema), asyncHandler(async (req, res) => ok(res, await productService.updateBrand(req.params.id, req.body, actor(req)))));
router.delete('/brands/:id',  authorize(PERMISSIONS.PRODUCTS_DELETE),  asyncHandler(async (req, res) => { await productService.deleteBrand(req.params.id, actor(req)); ok(res, { message: 'Deleted' }); }));

// ── CATEGORIES (must be before /:id) ──────────────────────────────────────
router.get(   '/categories',       authorize(PERMISSIONS.PRODUCTS_READ),    asyncHandler(async (_r, res) => ok(res, await productService.listCategories())));
router.post(  '/categories',       authorize(PERMISSIONS.CATEGORIES_MANAGE), validate(createCategorySchema), asyncHandler(async (req, res) => ok(res, await productService.createCategory(req.body, actor(req)), 201)));
router.patch( '/categories/:id',   authorize(PERMISSIONS.CATEGORIES_MANAGE), validate(updateCategorySchema), asyncHandler(async (req, res) => ok(res, await productService.updateCategory(req.params.id, req.body, actor(req)))));
router.post('/categories/dedup', authorize(PERMISSIONS.CATEGORIES_MANAGE), asyncHandler(async (_r, res) => ok(res, await productService.deduplicateCategories())));
router.delete('/categories/:id',   authorize(PERMISSIONS.CATEGORIES_MANAGE), asyncHandler(async (req, res) => { await productService.deleteCategory(req.params.id, actor(req)); ok(res, { message: 'Deleted' }); }));

// ── SAVED VIEWS (must be before /:id) ────────────────────────────────────
router.get(   '/views',      authorize(PERMISSIONS.PRODUCTS_READ),   asyncHandler(async (req, res) => ok(res, await productService.listSavedViews(req.user!.id))));
router.post(  '/views',      authorize(PERMISSIONS.PRODUCTS_READ),   validate(savedViewSchema), asyncHandler(async (req, res) => ok(res, await productService.createSavedView(req.user!.id, req.body), 201)));
router.patch( '/views/:id',  authorize(PERMISSIONS.PRODUCTS_READ),   asyncHandler(async (req, res) => ok(res, await productService.updateSavedView(req.params.id, req.user!.id, req.body))));
router.delete('/views/:id',  authorize(PERMISSIONS.PRODUCTS_READ),   asyncHandler(async (req, res) => { await productService.deleteSavedView(req.params.id, req.user!.id); ok(res, { message: 'Deleted' }); }));

// ── STATS (must be before /:id) ───────────────────────────────────────────
router.get('/stats', authorize(PERMISSIONS.PRODUCTS_READ), asyncHandler(async (_r, res) => ok(res, await productService.getStats())));

// ── BULK (must be before /:id) ────────────────────────────────────────────
router.post('/bulk-import', authorize(PERMISSIONS.PRODUCTS_CREATE), asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  ok(res, await productService.bulkImport(rows, actor(req)));
}));
router.post('/bulk', authorize(PERMISSIONS.PRODUCTS_UPDATE), validate(bulkUpdateSchema), asyncHandler(async (req, res) => ok(res, await productService.bulkUpdate(req.body.ids, req.body, actor(req)))));

// ── PRODUCT LIST & CREATE ─────────────────────────────────────────────────
router.get( '/', authorize(PERMISSIONS.PRODUCTS_READ),   validate(listProductsSchema, 'query'), asyncHandler(async (req, res) => ok(res, await productService.list(req.query as any))));
router.post('/', authorize(PERMISSIONS.PRODUCTS_CREATE), validate(createProductSchema),          asyncHandler(async (req, res) => ok(res, await productService.create(req.body, actor(req)), 201)));

// ── SINGLE PRODUCT by ID (must be LAST among GETs) ───────────────────────
router.get(   '/:id',              authorize(PERMISSIONS.PRODUCTS_READ),   validate(idParamSchema, 'params'),  asyncHandler(async (req, res) => ok(res, await productService.get(req.params.id))));
router.patch( '/:id',              authorize(PERMISSIONS.PRODUCTS_UPDATE), validate(idParamSchema, 'params'), validate(updateProductSchema), asyncHandler(async (req, res) => ok(res, await productService.update(req.params.id, req.body, actor(req)))));
router.delete('/bulk-delete', authorize(PERMISSIONS.PRODUCTS_DELETE), asyncHandler(async (req, res) => {
  const { ids } = req.body as { ids: string[] };
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids array required');
  const result = await productService.bulkDelete(ids, actor(req));
  ok(res, result);
}));

router.delete('/:id',              authorize(PERMISSIONS.PRODUCTS_DELETE), validate(idParamSchema, 'params'),  asyncHandler(async (req, res) => { await productService.remove(req.params.id, actor(req)); ok(res, { message: 'Deleted' }); }));
router.post(  '/:id/restore',      authorize(PERMISSIONS.PRODUCTS_UPDATE), validate(idParamSchema, 'params'),  asyncHandler(async (req, res) => ok(res, await productService.restore(req.params.id, actor(req)))));
router.post(  '/:id/attributes',   authorize(PERMISSIONS.PRODUCTS_UPDATE), validate(idParamSchema, 'params'), validate(setAttributesSchema), asyncHandler(async (req, res) => ok(res, await productService.setAttributes(req.params.id, req.body.attributes, actor(req)))));

export default router;
