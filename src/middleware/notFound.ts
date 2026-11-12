import { NotFoundError } from '../core/errors';
import type { NextFunction, Request, Response } from 'express';

/**
 * Converts an unmatched route into a structured 404.
 *
 * Registered last so every unknown path produces the same JSON envelope as any
 * other error rather than Express's default HTML page.
 *
 * @param {Request} req Request.
 * @param {Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function notFound(req: Request, res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}.`));
}

export default notFound;
