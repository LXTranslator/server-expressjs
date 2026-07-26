'use strict';

const { NotFoundError } = require('../core/errors');

/**
 * Converts an unmatched route into a structured 404.
 *
 * Registered last so every unknown path produces the same JSON envelope as any
 * other error rather than Express's default HTML page.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function notFound(req, res, next) {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}.`));
}

module.exports = notFound;
