import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { BadRequestError } from '../common/errors';

type Source = 'body' | 'query' | 'params';

// Validates + coerces a request part against a Zod schema, replacing it with
// the parsed (typed) result so handlers receive clean data.
export const validate =
  (schema: ZodSchema, source: Source = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new BadRequestError('Validation failed', result.error.flatten()));
    }
    req[source] = result.data;
    next();
  };
