import { ErrorRequestHandler, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { fail } from '../common/apiResponse';
import { logger } from '../config/logger';
import { isProd } from '../config/env';

export const notFoundHandler = (req: Request, res: Response): Response =>
  fail(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err }, err.message);
    return fail(res, err.statusCode, err.code, err.message, err.details);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return fail(res, 409, 'CONFLICT', 'Unique constraint violation', { target: err.meta?.target });
    }
    if (err.code === 'P2025') {
      return fail(res, 404, 'NOT_FOUND', 'Record not found');
    }
  }

  logger.error({ err }, 'Unhandled error');
  return fail(
    res,
    500,
    'INTERNAL_ERROR',
    isProd ? 'Internal server error' : String((err as Error)?.message ?? err),
  );
};
