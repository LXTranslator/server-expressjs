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

module.exports = router;
