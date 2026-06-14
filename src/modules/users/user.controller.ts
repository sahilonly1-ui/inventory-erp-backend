import { Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { userService } from './user.service';

const actor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, ip: req.ip ?? null };
};

export const userController = {
  create: asyncHandler(async (req: Request, res: Response) => {
    const a = actor(req);
    ok(res, await userService.create(req.body, a.id, a.ip), 201);
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await userService.list(req.query as never));
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await userService.getById(req.params.id));
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const a = actor(req);
    ok(res, await userService.update(req.params.id, req.body, a.id, a.ip));
  }),

  assignRoles: asyncHandler(async (req: Request, res: Response) => {
    const a = actor(req);
    ok(res, await userService.assignRoles(req.params.id, req.body.roleIds, a.id, a.ip));
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    const a = actor(req);
    await userService.softDelete(req.params.id, a.id, a.ip);
    ok(res, { message: 'User deleted (soft)' });
  }),

  restore: asyncHandler(async (req: Request, res: Response) => {
    const a = actor(req);
    ok(res, await userService.restore(req.params.id, a.id, a.ip));
  }),
};
