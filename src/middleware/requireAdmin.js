'use strict';

const { assertAdmin } = require('../modules/namespaces/namespace.service');

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
function requireAdmin(req, res, next) {
  assertAdmin(req.namespace, req.namespaceRole);
  next();
}

module.exports = requireAdmin;
