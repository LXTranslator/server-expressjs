'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');
const { TooManyRequestsError } = require('../core/errors');

/**
 * Rate limiters.
 *
 * Limits are tiered by how attractive an endpoint is to abuse rather than
 * applied uniformly: credential endpoints are the tightest, the account
 * availability probe is tight because it is an enumeration oracle, uploads are
 * tight because each one costs worker time and vendor quota, and everything
 * else shares a generous global bucket.
 *
 * All limiters are disabled under test so the suite is not throttled by its own
 * speed.
 */

/**
 * Builds one limiter.
 *
 * @param {{max: number, windowMs?: number, message: string}} options Limiter options.
 * @returns {Function} Express middleware.
 */
function build({ max, windowMs = config.rateLimit.windowMs, message }) {
  if (!config.rateLimit.enabled) {
    return function disabledLimiter(req, res, next) {
      next();
    };
  }

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
      next(new TooManyRequestsError(message));
    },
  });
}

/** Broad ceiling applied to the whole API. */
const globalLimiter = build({
  max: config.rateLimit.globalMax,
  message: 'Too many requests. Slow down and try again shortly.',
});

/** Login, registration and password reset. Guards against credential stuffing. */
const authLimiter = build({
  max: config.rateLimit.authMax,
  message: 'Too many authentication attempts. Try again in a few minutes.',
});

/**
 * Availability checks for user id and email.
 *
 * This endpoint necessarily reveals whether an identifier is taken, which the
 * registration form needs. A tight limit keeps that from being used to harvest
 * the whole account list.
 */
const availabilityLimiter = build({
  max: config.rateLimit.availabilityMax,
  message: 'Too many availability checks. Try again shortly.',
});

/** File uploads, each of which consumes a worker thread and vendor quota. */
const uploadLimiter = build({
  max: config.rateLimit.uploadMax,
  message: 'Too many uploads. Wait for the current files to finish processing.',
});

module.exports = { globalLimiter, authLimiter, availabilityLimiter, uploadLimiter };
