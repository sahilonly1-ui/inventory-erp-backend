import { Router } from 'express';
import { userController } from './user.controller';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import {
  createUserSchema,
  updateUserSchema,
  assignRolesSchema,
  listUsersSchema,
  idParamSchema,
} from './user.validator';

const router = Router();

// Every route requires a valid session; each action is permission-gated.
router.use(authenticate);

router.post('/', authorize(PERMISSIONS.USERS_CREATE), validate(createUserSchema), userController.create);
router.get('/', authorize(PERMISSIONS.USERS_READ), validate(listUsersSchema, 'query'), userController.list);
router.get('/:id', authorize(PERMISSIONS.USERS_READ), validate(idParamSchema, 'params'), userController.getById);
router.patch('/:id', authorize(PERMISSIONS.USERS_UPDATE), validate(idParamSchema, 'params'), validate(updateUserSchema), userController.update);
router.put('/:id/roles', authorize(PERMISSIONS.ROLES_MANAGE), validate(idParamSchema, 'params'), validate(assignRolesSchema), userController.assignRoles);
router.delete('/:id', authorize(PERMISSIONS.USERS_DELETE), validate(idParamSchema, 'params'), userController.remove);
router.post('/:id/restore', authorize(PERMISSIONS.USERS_RESTORE), validate(idParamSchema, 'params'), userController.restore);

export default router;
