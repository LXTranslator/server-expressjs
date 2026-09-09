'use strict';

const asyncHandler = require('../../core/asyncHandler');
const registry = require('../../infrastructure/oauth/providers');
const oauthService = require('./oauth.service');

/**
 * HTTP translation for provider sign in.
 *
 * Link and sign in are separate routes rather than one route that decides from
 * whether a token happened to be present. A single route where a missing check
 * silently downgrades a link to a sign in is the wrong way round to fail.
 */

/**
 * Records where a sign in came from.
 *
 * @param {import('express').Request} req Request.
 * @returns {{userAgent?: string}} Session context.
 */
function clientContext(req) {
  return { userAgent: req.get('user-agent') ?? undefined };
}

/**
 * GET /auth/oauth/providers
 * Lists the providers this deployment actually configured.
 */
const listProviders = asyncHandler(async (req, res) => {
  // An empty list is the ordinary answer for a deployment that enabled none of
  // them, and it is what tells the client to render nothing at all rather than
  // a button that cannot work.
  res.json({ data: { providers: registry.listEnabled() } });
});

/**
 * POST /auth/oauth/:provider/login/start
 * Begins a sign in through a linked provider account.
 */
const startLogin = asyncHandler(async (req, res) => {
  const result = await oauthService.startFlow({
    providerName: req.params.provider,
    mode: 'LOGIN',
  });
  res.json({ data: result });
});

/**
 * POST /auth/oauth/:provider/link/start
 * Begins linking a provider account to the signed in account.
 */
const startLink = asyncHandler(async (req, res) => {
  const result = await oauthService.startFlow({
    providerName: req.params.provider,
    mode: 'LINK',
    account: req.account,
  });
  res.json({ data: result });
});

/**
 * POST /auth/oauth/login/callback
 * Completes a sign in, or hands back a second factor challenge.
 */
const completeLogin = asyncHandler(async (req, res) => {
  const result = await oauthService.completeLogin({
    state: req.body.state,
    code: req.body.code,
    context: clientContext(req),
  });

  if (result.mfaRequired) {
    // The same shape a password sign in produces, so the client has one branch
    // rather than two.
    res.json({
      data: {
        mfa_required: true,
        challenge_token: result.challengeToken,
        expires_in: result.expiresIn,
      },
    });
    return;
  }

  res.json({
    data: {
      account: result.account.toPublicJson(),
      access_token: result.token,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
    },
  });
});

/**
 * POST /auth/oauth/link/callback
 * Completes a link.
 */
const completeLink = asyncHandler(async (req, res) => {
  const identity = await oauthService.completeLink({
    account: req.account,
    state: req.body.state,
    code: req.body.code,
  });
  res.status(201).json({ data: { identity: identity.toPublicJson() } });
});

/**
 * GET /auth/oauth/identities
 * Lists the provider accounts linked to this account.
 */
const listIdentities = asyncHandler(async (req, res) => {
  res.json({ data: { identities: await oauthService.listIdentities(req.account.id) } });
});

/**
 * DELETE /auth/oauth/:provider
 * Unlinks a provider account.
 */
const unlink = asyncHandler(async (req, res) => {
  await oauthService.unlink(req.account.id, req.params.provider);
  res.status(204).send();
});

module.exports = {
  listProviders,
  startLogin,
  startLink,
  completeLogin,
  completeLink,
  listIdentities,
  unlink,
};
