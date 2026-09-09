'use strict';

const express = require('express');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { authLimiter, availabilityLimiter } = require('../../middleware/rateLimit');
const controller = require('./oauth.controller');
const schemas = require('./oauth.schemas');

/**
 * Provider sign in routes.
 *
 * Mounted under `/auth` by `auth.routes.js`, which is where `requireSession`
 * lives. Link and unlink both take it: binding a provider account creates
 * another way to prove this identity, which is at least as powerful as minting
 * an API token, and rule twelve is that a token may not manage credentials.
 *
 * @param {Function} requireSession Guard refusing API token callers.
 * @returns {import('express').Router} The router.
 */
module.exports = (requireSession) => {
  const router = express.Router();

  router.get('/providers', availabilityLimiter, controller.listProviders);

  router.post(
    '/:provider/login/start',
    authLimiter,
    validate(schemas.startSchema),
    controller.startLogin,
  );

  router.post(
    '/login/callback',
    authLimiter,
    validate(schemas.callbackSchema),
    controller.completeLogin,
  );

  router.post(
    '/:provider/link/start',
    authenticate,
    requireSession,
    authLimiter,
    validate(schemas.startSchema),
    controller.startLink,
  );

  router.post(
    '/link/callback',
    authenticate,
    requireSession,
    authLimiter,
    validate(schemas.callbackSchema),
    controller.completeLink,
  );

  router.get('/identities', authenticate, controller.listIdentities);

  router.delete('/:provider', authenticate, requireSession, controller.unlink);

  return router;
};
