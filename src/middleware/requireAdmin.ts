import { assertAdmin } from '../modules/namespaces/namespace.service';
import type { NextFunction, Request, Response } from 'express';

/**
 * Requires at least ADMIN inside an organization.
 *
 * Mounted after a router has resolved `req.namespace` and `req.namespaceRole`.
 * A personal namespace has a single owner, so the check passes there.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 * @throws {import('../core/errors').ForbiddenError} When the role is insufficient.
 */
function requireAdmin<P>(req: Request<P>, res: Response, next: NextFunction): void {
  assertAdmin(req.namespace, req.namespaceRole);
  next();
}

export default requireAdmin;
