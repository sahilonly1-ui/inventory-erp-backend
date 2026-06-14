import { Router } from 'express';
import { productController } from './product.controller';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { createProductSchema, updateProductSchema, listProductsSchema, idParamSchema, createCategorySchema } from './product.validator';

const router = Router();
router.use(authenticate);

router.post('/categories', authorize(PERMISSIONS.CATEGORIES_MANAGE), validate(createCategorySchema), productController.createCategory);
router.get('/categories', authorize(PERMISSIONS.PRODUCTS_READ), productController.listCategories);

router.post('/', authorize(PERMISSIONS.PRODUCTS_CREATE), validate(createProductSchema), productController.create);
router.get('/', authorize(PERMISSIONS.PRODUCTS_READ), validate(listProductsSchema, 'query'), productController.list);
router.get('/:id', authorize(PERMISSIONS.PRODUCTS_READ), validate(idParamSchema, 'params'), productController.get);
router.patch('/:id', authorize(PERMISSIONS.PRODUCTS_UPDATE), validate(idParamSchema, 'params'), validate(updateProductSchema), productController.update);
router.delete('/:id', authorize(PERMISSIONS.PRODUCTS_DELETE), validate(idParamSchema, 'params'), productController.remove);
router.post('/:id/restore', authorize(PERMISSIONS.PRODUCTS_CREATE), validate(idParamSchema, 'params'), productController.restore);

export default router;
