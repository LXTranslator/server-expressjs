'use strict';

const express = require('express');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { authLimiter, availabilityLimiter } = require('../../middleware/rateLimit');
const controller = require('./auth.controller');
const schemas = require('./auth.schemas');

const router = express.Router();

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

module.exports = router;
