'use strict';

const { requestJson } = require('./http');
const { UnauthorizedError } = require('../../../core/errors');

/**
 * github.com.
 *
 * Every URL below is a constant. Making any of them configurable would turn a
 * sign in into an arbitrary outbound request, which is the rule
 * `security/ssrf.md` exists to hold. That is also why GitHub Enterprise Server
 * is not supported here: it would need exactly that.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

/** Headers the REST API expects. The version pin keeps a future default from moving under us. */
const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * Exchanges an authorization code for an access token.
 *
 * @param {{code: string, redirectUri: string, clientId: string, clientSecret: string,
 *   codeVerifier: string|null}} params Exchange parameters.
 * @returns {Promise<string>} The access token.
 * @throws {UnauthorizedError} When the code cannot be exchanged.
 */
async function exchangeCode({ code, redirectUri, clientId, clientSecret, codeVerifier }) {
  const body = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  };
  if (codeVerifier !== null) body.code_verifier = codeVerifier;

  const { payload } = await requestJson(TOKEN_URL, {
    method: 'POST',
    // Without an explicit JSON Accept, this endpoint answers form encoded.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /*
   * GitHub answers a failed exchange with HTTP 200 and an error body. Keying
   * off the status alone, the way the AI adapters do, would sail past this and
   * then read `access_token` off an error object.
   */
  if (payload.error !== undefined || typeof payload.access_token !== 'string') {
    throw new UnauthorizedError('That sign in attempt could not be completed. Try again.');
  }

  return payload.access_token;
}

/**
 * Reads the identity behind an access token.
 *
 * The numeric id is the identity. A username is renameable and, once released,
 * claimable by somebody else, so matching an account on one would hand that
 * account to whoever picked the name up next.
 *
 * @param {string} accessToken Access token from the exchange.
 * @returns {Promise<{providerUserId: string, username: string, email: string|null}>}
 * @throws {UnauthorizedError} When the identity cannot be read.
 */
async function readIdentity(accessToken) {
  const headers = { ...API_HEADERS, Authorization: `Bearer ${accessToken}` };

  const { status, payload } = await requestJson(USER_URL, { headers });
  if (status !== 200 || payload.id === undefined) {
    throw new UnauthorizedError('That sign in attempt could not be completed. Try again.');
  }

  let email = typeof payload.email === 'string' ? payload.email : null;

  if (email === null) {
    // `/user` reports an address only when the person made it public, so the
    // primary verified one is asked for separately. It is display only either
    // way: nothing is ever matched on it.
    const emails = await requestJson(EMAILS_URL, { headers });
    if (Array.isArray(emails.payload)) {
      const primary = emails.payload.find((entry) => entry?.primary && entry?.verified);
      email = typeof primary?.email === 'string' ? primary.email : null;
    }
  }

  return {
    providerUserId: String(payload.id),
    username: typeof payload.login === 'string' ? payload.login : null,
    email,
  };
}

module.exports = {
  name: 'github',
  label: 'GitHub',
  authorizeUrl: AUTHORIZE_URL,
  scope: 'read:user user:email',
  // Supported since July 2025, S256 only, and optional rather than required.
  supportsPkce: true,
  pkceMethod: 'S256',
  requiresNetwork: true,
  exchangeCode,
  readIdentity,
};
