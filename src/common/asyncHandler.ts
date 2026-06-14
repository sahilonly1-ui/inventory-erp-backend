import { NextFunction, Request, Response, RequestHandler } from 'express';

// Wraps async route handlers so rejected promises reach the error middleware.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
