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
      // A bare "Validation failed" tells the operator nothing about which of a
      // hundred scanned rows is wrong. Surface the first few concrete problems,
      // with the path, so the offending value can actually be found.
      const issues = result.error.issues.slice(0, 3).map(i => {
        const where = i.path.filter(p => typeof p !== 'number').join('.');
        return where ? `${where}: ${i.message}` : i.message;
      });
      const extra = result.error.issues.length - issues.length;
      const message = issues.length
        ? `${issues.join('; ')}${extra > 0 ? ` (+${extra} more)` : ''}`
        : 'Validation failed';
      return next(new BadRequestError(message, result.error.flatten()));
    }
    req[source] = result.data;
    next();
  };
