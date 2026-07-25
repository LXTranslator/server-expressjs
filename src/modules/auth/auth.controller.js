'use strict';

const asyncHandler = require('../../core/asyncHandler');
const { validated } = require('../../middleware/validate');
const authService = require('./auth.service');

/**
 * HTTP handlers for the authentication module.
 *
 * Controllers stay thin: they translate between HTTP and the service layer and
 * nothing more. All rules live in the service, which keeps them testable
 * without a request object and reusable from other entry points.
 */

/**
 * GET /auth/availability
 * Reports whether a user id or email may still be registered.
 */
const availability = asyncHandler(async (req, res) => {
  const query = validated(req, 'query');
  const result = await authService.checkAvailability({
    userId: query.user_id,
    email: query.email,
  });
  res.json({ data: result });
});

/**
 * POST /auth/register
 * Creates a personal namespace and returns a session.
 */
const register = asyncHandler(async (req, res) => {
  const { account, token, expiresIn } = await authService.register(req.body);
  res.status(201).json({
    data: {
      account: account.toPublicJson(),
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
    },
  });
});

/**
 * POST /auth/login
 * Exchanges credentials for a session token.
 */
const login = asyncHandler(async (req, res) => {
  const { account, token, expiresIn } = await authService.login(req.body);
  res.json({
    data: {
      account: account.toPublicJson(),
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
    },
  });
});

/**
 * POST /auth/forgot-password
 * Starts the reset flow. The response never reveals whether the address exists.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { token } = await authService.requestPasswordReset(req.body);
  res.json({
    data: {
      message:
        'If that address has an account, a reset link is on its way. The link expires in 10 minutes.',
      // Present outside production only, so the flow can be completed locally
      // and in the automated tests without an inbox.
      ...(token === null ? {} : { development_token: token }),
    },
  });
});

/**
 * POST /auth/reset-password
 * Completes the reset flow using a single use token.
 */
const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.json({
    data: { message: 'Your password has been updated. Sign in with your new password.' },
  });
});

/**
 * GET /auth/me
 * Returns the account behind the current session.
 */
const me = asyncHandler(async (req, res) => {
  res.json({ data: { account: req.account.toPublicJson() } });
});

module.exports = { availability, register, login, forgotPassword, resetPassword, me };
