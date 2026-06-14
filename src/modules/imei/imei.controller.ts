import { Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { imeiService } from './imei.service';

const actor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, ip: req.ip ?? null };
};

export const imeiController = {
  receive: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await imeiService.receive(req.body, actor(req)), 201);
  }),
  dispatch: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await imeiService.dispatch(req.body, actor(req)), 201);
  }),
  changeStatus: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await imeiService.changeStatus(req.params.imei, req.body.status, req.body.reason, actor(req)));
  }),
  lookup: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await imeiService.lookup(req.params.imei));
  }),
  list: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await imeiService.list(req.query as never));
  }),
};
