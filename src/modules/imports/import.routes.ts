import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ImportType } from '@prisma/client';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { BadRequestError, UnauthorizedError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { PERMISSIONS } from '../../constants/permissions';
import { importService } from './import.service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

const typeParam = z.object({ type: z.nativeEnum(ImportType) });

const router = Router();
router.use(authenticate);

router.post(
  '/:type',
  authorize(PERMISSIONS.IMPORTS_RUN),
  validate(typeParam, 'params'),
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const file = (req as Request & { file?: { originalname: string; buffer: Buffer } }).file;
    if (!file) throw new BadRequestError('Upload an .xlsx/.xlsm file in the "file" field');
    const result = await importService.run(
      req.params.type as never,
      file.originalname,
      file.buffer,
      { id: req.user.id, ip: req.ip ?? null },
    );
    ok(res, result, 201);
  }),
);

export default router;
