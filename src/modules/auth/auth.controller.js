'use strict';

const asyncHandler = require('../../core/asyncHandler');
const { validated } = require('../../middleware/validate');
const authService = require('./auth.service');
const sessionService = require('./session.service');

/**
 * HTTP handlers for the authentication module.
 *
 * Controllers stay thin: they translate between HTTP and the service layer and
 * nothing more. All rules live in the service, which keeps them testable
 * without a request object and reusable from other entry points.
 */

/**
 * Describes the client a session is being created for.
 *
 * The user agent is the only thing recorded, and only so a list of sessions is
 * actionable: "sign out the one I do not recognise" needs something to
 * recognise. The address the request came from is deliberately not stored. It
 * locates a person, it changes constantly, and it answers that question worse
 * than the device string does.
 *
 * @param {import('express').Request} req Request.
 * @returns {{userAgent: string|undefined}} Session context.
 */
function clientContext(req) {
  return { userAgent: req.get('user-agent') ?? undefined };
}

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
  const { account, token, expiresIn } = await authService.register(
    req.body,
    clientContext(req),
  );
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
  const { account, token, expiresIn } = await authService.login(
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

/**
 * POST /auth/logout
 * Ends the session this request was made with.
 *
 * A real end, not a client side forget. Before sessions were recorded, signing
 * out could only drop the token locally and it stayed valid for the rest of its
 * lifetime anywhere else it had been copied.
 */
const logout = asyncHandler(async (req, res) => {
  await sessionService.revokeSession({
    accountId: req.account.id,
    sessionId: req.session.id,
  });
  res.status(204).send();
});

/**
 * GET /auth/sessions
 * Lists where this account is currently signed in.
 */
const listSessions = asyncHandler(async (req, res) => {
  const sessions = await sessionService.listSessions({
    accountId: req.account.id,
    kind: 'SESSION',
  });

  // Saying which row is the caller's own is what makes the list usable: the
  // one you are reading it from is the one you must not end by accident.
  res.json({
    data: {
      sessions: sessions.map((session) => ({
        ...session,
        current: session.id === req.session.id,
      })),
    },
  });
});

/**
 * DELETE /auth/sessions/:sessionId
 * Ends one session, which may be the current one.
 */
const revokeSession = asyncHandler(async (req, res) => {
  await sessionService.revokeSession({
    accountId: req.account.id,
    sessionId: req.params.sessionId,
    kind: 'SESSION',
  });
  res.status(204).send();
});

/**
 * POST /auth/sessions/revoke_others
 * Ends every other session, keeping the one asking.
 */
const revokeOtherSessions = asyncHandler(async (req, res) => {
  const revoked = await sessionService.revokeAll({
    accountId: req.account.id,
    exceptId: req.session.id,
    kind: 'SESSION',
  });
  res.json({ data: { revoked } });
});

module.exports = {
  availability,
  register,
  login,
  forgotPassword,
  resetPassword,
  me,
  logout,
  listSessions,
  revokeSession,
  revokeOtherSessions,
};
