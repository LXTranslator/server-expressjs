import express from 'express';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter } from '../../middleware/rateLimit';
import * as controller from './mfa.controller';
import * as schemas from './mfa.schemas';
import type { RequestHandler, Router } from 'express';

/**
 * Second factor routes.
 *
 * Mounted under `/auth` by `auth.routes.js`, which is also where the
 * `requireSession` guard lives. Every route that changes the factor takes that
 * guard as well as a settings token: enrolling a second way to prove an
 * identity is at least as sensitive as minting an API token, and rule twelve of
 * the authentication policy is that a token may not manage credentials.
 *
 * @param {Function} requireSession Guard refusing API token callers.
 * @returns {Router} The router.
 */
export default (requireSession: RequestHandler): Router => {
  const router = express.Router();

  router.get('/', authenticate, controller.status);

  router.post(
    '/setup',
    authenticate,
    requireSession,
    authLimiter,
    validate(schemas.setupSchema),
    controller.setup,
  );

  router.post(
    '/enable',
    authenticate,
    requireSession,
    authLimiter,
    validate(schemas.enableSchema),
    controller.enable,
  );

  router.post(
    '/recovery_codes',
    authenticate,
    requireSession,
    authLimiter,
    validate(schemas.regenerateSchema),
    controller.regenerate,
  );

  router.post(
    '/disable',
    authenticate,
    requireSession,
    authLimiter,
    validate(schemas.disableSchema),
    controller.disable,
  );

  return router;
};
