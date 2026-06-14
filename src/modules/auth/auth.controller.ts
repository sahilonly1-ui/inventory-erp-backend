import { Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { isProd } from '../../config/env';
import { authService } from './auth.service';
import { RequestContext } from './auth.dto';

const ctx = (req: Request): RequestContext => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password, ctx(req));
    ok(res, result);
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const tokens = await authService.refresh(req.body.refreshToken);
    ok(res, tokens);
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    await authService.logout(req.body.refreshToken);
    ok(res, { message: 'Logged out' });
  }),

  forgotPassword: asyncHandler(async (req: Request, res: Response) => {
    const token = await authService.forgotPassword(req.body.email);
    // Generic response prevents account enumeration. Token surfaced only in dev.
    ok(res, {
      message: 'If the account exists, a reset link has been sent',
      ...(isProd ? {} : { devToken: token }),
    });
  }),

  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.resetPassword(req.body.token, req.body.newPassword);
    ok(res, { message: 'Password updated' });
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    await authService.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    ok(res, { message: 'Password changed' });
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    ok(res, await authService.me(req.user.id));
  }),
};
