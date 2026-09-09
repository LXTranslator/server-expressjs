'use strict';

const asyncHandler = require('../../core/asyncHandler');
const mfaService = require('./mfa.service');
const authService = require('./auth.service');
const accountService = require('../accounts/account.service');

/**
 * HTTP translation for the second factor.
 *
 * Every change to the factor itself is gated behind a settings token, the same
 * single use confirmation the password and email changes use. Turning a second
 * factor off is exactly as sensitive as turning it on, so a stolen session
 * cannot quietly remove it.
 */

/**
 * Records where a sign in came from.
 *
 * The user agent only. The address is deliberately not stored; a session list
 * is for recognising your own devices, not for building a location history.
 *
 * @param {import('express').Request} req Request.
 * @returns {{userAgent?: string}} Session context.
 */
function clientContext(req) {
  return { userAgent: req.get('user-agent') ?? undefined };
}

/**
 * GET /auth/mfa
 * Reports whether a second factor is enrolled, confirmed, and how many
 * recovery codes are left.
 */
const status = asyncHandler(async (req, res) => {
  res.json({ data: await mfaService.describe(req.account.id) });
});

/**
 * POST /auth/mfa/setup
 * Starts enrolment and returns the secret exactly once.
 */
const setup = asyncHandler(async (req, res) => {
  await accountService.redeemSettingsToken(req.account, req.body.settings_token);
  const result = await mfaService.beginEnrolment(req.account);
  res.status(201).json({
    data: {
      ...result,
      warning: 'Copy this secret now. It cannot be shown again.',
    },
  });
});

/**
 * POST /auth/mfa/enable
 * Confirms enrolment with a code and returns the recovery codes exactly once.
 */
const enable = asyncHandler(async (req, res) => {
  await accountService.redeemSettingsToken(req.account, req.body.settings_token);
  const { recovery_codes: recoveryCodes } = await mfaService.confirmEnrolment(req.account, req.body);
  res.json({
    data: {
      enabled: true,
      recovery_codes: recoveryCodes,
      warning: 'Store these now. They cannot be shown again.',
    },
  });
});

/**
 * POST /auth/mfa/recovery_codes
 * Replaces every recovery code with a fresh set.
 */
const regenerate = asyncHandler(async (req, res) => {
  await accountService.redeemSettingsToken(req.account, req.body.settings_token);
  const codes = await mfaService.regenerateRecoveryCodes(req.account.id);
  res.json({
    data: {
      recovery_codes: codes,
      warning: 'Store these now. They replace every earlier code.',
    },
  });
});

/**
 * POST /auth/mfa/disable
 * Removes the second factor and every recovery code with it.
 *
 * A POST rather than a DELETE because it carries a settings token in its body,
 * and a DELETE body is not reliably sent by every client or forwarded by every
 * proxy. No other route in this module puts a payload on a DELETE either.
 */
const disable = asyncHandler(async (req, res) => {
  await accountService.redeemSettingsToken(req.account, req.body.settings_token);
  await mfaService.disable(req.account);
  res.status(204).send();
});

/**
 * POST /auth/login/mfa
 * Answers a login challenge and, if the code holds, starts the session.
 */
const completeChallenge = asyncHandler(async (req, res) => {
  const { account, token, expiresIn } = await authService.completeMfaChallenge(
    req.body,
    clientContext(req),
  );
  res.json({
    data: {
      account: account.toPublicJson(),
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
    },
  });
});

module.exports = { status, setup, enable, regenerate, disable, completeChallenge };
