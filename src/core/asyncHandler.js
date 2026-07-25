'use strict';

/**
 * Wraps an async route handler so a rejected promise reaches the Express error
 * pipeline instead of surfacing as an unhandled rejection.
 *
 * Express 5 forwards rejections automatically, but wrapping explicitly keeps
 * the behaviour obvious at every call site and independent of the framework
 * major version.
 *
 * @param {Function} handler Async request handler.
 * @returns {Function} Express compatible handler.
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
