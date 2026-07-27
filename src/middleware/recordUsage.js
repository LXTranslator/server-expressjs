'use strict';

const config = require('../config');
const usageService = require('../modules/usage/usage.service');

/**
 * Records what an authenticated request did.
 *
 * Attached to the response rather than wrapped around the handler, so the
 * status and the duration are the real ones: an error handler may change a
 * status long after the route decided what to do, and only the response knows
 * how it actually finished.
 *
 * Nothing is written here. The entry is queued and a batch is written later, so
 * the response path never waits on a database insert to record something nobody
 * is waiting to read.
 *
 * Only authenticated requests are recorded, because an unauthenticated one has
 * no account to attribute it to. That leaves sign in attempts out of this
 * table, which is the right place for them not to be: those belong to the
 * lockout counter and the application log, and recording them here would mean
 * writing rows for people who are not the account holder.
 */

/** Paths that would fill the table without ever answering a question. */
const IGNORED_PATHS = new Set(['/api/v1/health']);

/**
 * Strips the query string and bounds the length.
 *
 * The query string is dropped deliberately. It carries search terms and other
 * things somebody typed, and an audit trail has no business accumulating them
 * to answer a question the path and the status already answer.
 *
 * @param {string} url Original request URL.
 * @returns {string} Storable path.
 */
function toStorablePath(url) {
  const [path] = String(url ?? '').split('?');
  return path.slice(0, 300);
}

/**
 * Express middleware recording each authenticated request once it finishes.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function recordUsage(req, res, next) {
  if (!config.usage.enabled || IGNORED_PATHS.has(req.originalUrl?.split('?')[0])) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  // `finish` fires once the response has been handed to the socket. `close`
  // covers a client that gave up first, which is exactly the case worth seeing
  // in a record of what a script has been doing.
  let recorded = false;

  const write = () => {
    if (recorded) return;
    recorded = true;

    // Read after the response, not before: authentication runs downstream of
    // this middleware, so `req.account` does not exist yet on the way in.
    if (req.account === undefined || req.account === null) return;

    usageService.record({
      accountId: req.account.id,
      sessionId: req.session?.id ?? null,
      credentialKind: req.session?.kind ?? null,
      method: req.method,
      path: toStorablePath(req.originalUrl),
      statusCode: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      createdAt: new Date(),
    });
  };

  res.on('finish', write);
  res.on('close', write);

  next();
}

module.exports = { recordUsage, toStorablePath, IGNORED_PATHS };
