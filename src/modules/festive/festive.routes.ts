import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { BadRequestError } from '../../common/errors';
import { authenticate } from '../../middlewares/authenticate';
import * as svc from './festive.service';

const router = Router();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Public: festival days from Drik Panchang (no business data) — the look is set before sign-in.
router.get('/events', asyncHandler(async (req: Request, res: Response) => {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!DAY.test(from) || !DAY.test(to)) throw new BadRequestError('from and to must be YYYY-MM-DD');
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!(span >= 0 && span <= 400)) throw new BadRequestError('Range must be 0–400 days');
  res.set('Cache-Control', 'public, max-age=3600');
  ok(res, await svc.events(from, to));
}));

router.get('/status', authenticate, asyncHandler(async (_req: Request, res: Response) => ok(res, await svc.status())));
router.post('/sync', authenticate, asyncHandler(async (_req: Request, res: Response) => ok(res, await svc.syncFromDrik())));

export default router;
