import { ValidationError } from '../core/errors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Builds a middleware that validates one part of the request against a Zod
 * schema and replaces it with the parsed result.
 *
 * Replacing rather than merging is the important part: the handler downstream
 * sees only fields the schema declared. An attacker cannot smuggle an extra
 * property such as `type: "ORG"` or `role: "OWNER"` into a payload and have it
 * reach a model, which is the mass assignment class of bug.
 *
 * @param {import('zod').ZodType} schema Schema to apply.
 * @param {'body'|'query'|'params'} [source] Request property to validate.
 * @returns {Function} Express middleware.
 */
function validate<P = Record<string, string>>(schema: ZodType, source: 'body' | 'query' | 'params' = 'body'): RequestHandler<P> {
  return function validateRequest(req: Request<P>, res: Response, next: NextFunction): void {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      next(new ValidationError('The submitted data failed validation.', details));
      return;
    }

    // `req.query` and `req.params` are getter only on Express 5, so the parsed
    // value is stored alongside rather than assigned back.
    if (source === 'body') {
      req.body = result.data;
    } else {
      req.validated = { ...(req.validated ?? {}), [source]: result.data };
    }

    next();
  };
}

/**
 * Reads a validated value, falling back to the raw request property.
 *
 * @param {import('express').Request} req Request.
 * @param {'query'|'params'} source Request property.
 * @returns {T} Validated data, typed by the caller from the schema that produced it.
 */
function validated<T>(req: Request, source: 'query' | 'params'): T {
  return (req.validated?.[source] ?? req[source]) as T;
}

export { validate, validated };
