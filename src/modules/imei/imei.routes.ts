import { Router } from 'express';
import { imeiController } from './imei.controller';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import {
  receiveImeiSchema, dispatchImeiSchema, changeStatusSchema, imeiParamSchema, imeiQuerySchema,
} from './imei.validator';

const router = Router();
router.use(authenticate);

router.post('/receive', authorize(PERMISSIONS.IMEI_MANAGE), validate(receiveImeiSchema), imeiController.receive);
router.post('/dispatch', authorize(PERMISSIONS.IMEI_MANAGE), validate(dispatchImeiSchema), imeiController.dispatch);
router.patch('/:imei/status', authorize(PERMISSIONS.IMEI_MANAGE), validate(imeiParamSchema, 'params'), validate(changeStatusSchema), imeiController.changeStatus);

router.get('/', authorize(PERMISSIONS.IMEI_READ), validate(imeiQuerySchema, 'query'), imeiController.list);
router.get('/:imei', authorize(PERMISSIONS.IMEI_READ), validate(imeiParamSchema, 'params'), imeiController.lookup);

export default router;
