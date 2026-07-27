'use strict';

const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { recordUsage } = require('./middleware/recordUsage');
const cors = require('cors');
const config = require('./config');
const logger = require('./core/logger');
const apiRoutes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { globalLimiter } = require('./middleware/rateLimit');
const { ForbiddenError } = require('./core/errors');

/**
 * Builds the Express application.
 *
 * Exported as a factory rather than a singleton so the test suite can build an
 * app against an isolated database without starting a listener.
 *
 * @returns {import('express').Express} Configured application.
 */
function createApp() {
  const app = express();

  // Behind a load balancer the client address arrives in a header. This is only
  // trusted when explicitly configured, because trusting it unconditionally
  // would let any caller spoof their address and evade rate limiting.
  app.set('trust proxy', config.app.trustProxy);

  // Removes the framework banner, which otherwise advertises the stack.
  app.disable('x-powered-by');

  /*
   * Security headers.
   *
   * The API returns JSON only, so the content security policy is as restrictive
   * as it can be: nothing may be loaded or framed. Should any endpoint ever be
   * coaxed into returning markup, the browser refuses to execute it.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  /*
   * Cross origin access.
   *
   * An explicit allowlist, never a reflected origin. Credentials are carried in
   * an Authorization header rather than a cookie, so there is no ambient
   * authority for a cross site request to abuse, and no CSRF token is required.
   */
  app.use(
    cors({
      origin(origin, callback) {
        // A request with no Origin is a server to server or tooling call.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (config.security.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new ForbiddenError('This origin is not permitted to call the API.'));
      },
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // A bounded body limit stops a large payload from exhausting memory before
  // any handler has a chance to reject it.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // A correlation id ties every log line for one request together.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // Before the routes, so it sees every authenticated request whatever the
  // route decides. It reads the account after the response, since
  // authentication runs downstream of this point.
  app.use(recordUsage);

  app.use(globalLimiter);

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.debug('Request completed.', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    });
    next();
  });

  app.use('/api/v1', apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
