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
