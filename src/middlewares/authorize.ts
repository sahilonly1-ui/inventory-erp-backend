import { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { WILDCARD } from '../constants/permissions';

// Usage: router.post('/', authenticate, authorize('users.create'), handler)
// All listed permissions are required (AND). WILDCARD ('*') bypasses checks.
export const authorize =
  (...required: string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.permissions.has(WILDCARD)) return next();

    const missing = required.filter((code) => !req.user!.permissions.has(code));
    if (missing.length > 0) {
      return next(new ForbiddenError(`Missing permission(s): ${missing.join(', ')}`));
    }
    next();
  };
