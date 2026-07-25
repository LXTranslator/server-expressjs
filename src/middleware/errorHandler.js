'use strict';

const config = require('../config');
const logger = require('../core/logger');
const { AppError } = require('../core/errors');

/**
 * Terminal error handler.
 *
 * Two rules govern everything here:
 *
 *   1. Only errors this application deliberately raised are described to the
 *      client. Anything else becomes a generic message, because an unexpected
 *      error's text can carry table names, file paths or fragments of a query.
 *   2. The full detail is always logged server side, so hiding it from the
 *      response never costs anyone the ability to debug.
 *
 * @param {Error} error Raised error.
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestContext = {
    method: req.method,
    path: req.originalUrl,
    accountId: req.account?.id ?? null,
    requestId: req.id ?? null,
  };

  if (error instanceof AppError) {
    // Expected failure: the message was written to be read by a client.
    const level = error.statusCode >= 500 ? 'error' : 'warn';
    logger[level]('Request failed.', {
      ...requestContext,
      code: error.code,
      statusCode: error.statusCode,
      message: error.message,
    });

    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  // Unexpected failure: log everything, disclose nothing.
  logger.error('Unhandled error.', {
    ...requestContext,
    name: error.name,
    message: error.message,
    stack: error.stack,
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. The incident has been logged.',
      // The stack is exposed only outside production, purely as a local
      // development convenience.
      ...(config.isProduction ? {} : { debug: error.message }),
    },
  });
}

module.exports = errorHandler;
