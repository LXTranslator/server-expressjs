'use strict';

const express = require('express');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { authLimiter, availabilityLimiter } = require('../../middleware/rateLimit');
const { ForbiddenError } = require('../../core/errors');
const controller = require('./auth.controller');
const schemas = require('./auth.schemas');

const router = express.Router();

/**
 * Refuses a request made with an API token rather than a signed in session.
 *
 * Guards the endpoints that manage credentials themselves. A token that can
 * mint and revoke tokens is a token that can replace itself, which would make
 * revoking the original pointless.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function requireSession(req, res, next) {
  if (req.session?.kind === 'API') {
    next(new ForbiddenError('Sign in to manage API tokens. A token cannot manage tokens.'));
    return;
  }
  next();
}

/**
 * Authentication routes.
 *
 * Every credential endpoint carries a rate limiter, and every payload is
 * validated against a strict schema before a handler runs.
 */

router.get(
  '/availability',
  availabilityLimiter,
  validate(schemas.availabilitySchema, 'query'),
  controller.availability,
);

router.post('/register', authLimiter, validate(schemas.registerSchema), controller.register);

router.post('/login', authLimiter, validate(schemas.loginSchema), controller.login);

router.post(
  '/password/forgot',
  authLimiter,
  validate(schemas.forgotPasswordSchema),
  controller.forgotPassword,
);

router.post(
  '/password/reset',
  authLimiter,
  validate(schemas.resetPasswordSchema),
  controller.resetPassword,
);

router.get('/me', authenticate, controller.me);

/*
 * Sessions.
 *
 * Where this account is signed in, and how to end any of it. Always the
 * caller's own: a session identifier is a UUID somebody could hold from
 * anywhere, so every one of these filters by the authenticated account as well
 * and answers 404 for a row belonging to somebody else.
 */

router.post('/logout', authenticate, controller.logout);

router.get('/sessions', authenticate, controller.listSessions);

router.post('/sessions/revoke_others', authenticate, controller.revokeOtherSessions);

router.delete('/sessions/:sessionId', authenticate, controller.revokeSession);

/*
 * API tokens.
 *
 * The credential a machine uses. Creating one is rate limited like any other
 * credential endpoint, because a token is a way into the account that outlives
 * the session that made it.
 *
 * Creating a token requires an ordinary session, so a token cannot mint another
 * token. Otherwise one leaked credential could quietly replace itself forever
 * and revoking the original would achieve nothing.
 */

router.post(
  '/api_tokens',
  authenticate,
  requireSession,
  authLimiter,
  validate(schemas.createApiTokenSchema),
  controller.createApiToken,
);

router.get('/api_tokens', authenticate, controller.listApiTokens);

router.delete(
  '/api_tokens/:tokenId',
  authenticate,
  requireSession,
  controller.revokeApiToken,
);

module.exports = router;
