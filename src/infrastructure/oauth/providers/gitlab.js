'use strict';

const { requestJson } = require('./http');
const { UnauthorizedError } = require('../../../core/errors');

/**
 * gitlab.com.
 *
 * Constant endpoints, for the reason given in the GitHub adapter. A self hosted
 * GitLab would need a configurable base URL, which is exactly what is refused.
 */

const AUTHORIZE_URL = 'https://gitlab.com/oauth/authorize';
const TOKEN_URL = 'https://gitlab.com/oauth/token';
const USER_URL = 'https://gitlab.com/api/v4/user';

/**
 * Exchanges an authorization code for an access token.
 *
 * @param {{code: string, redirectUri: string, clientId: string, clientSecret: string,
 *   codeVerifier: string|null}} params Exchange parameters.
 * @returns {Promise<string>} The access token.
 * @throws {UnauthorizedError} When the code cannot be exchanged.
 */
async function exchangeCode({ code, redirectUri, clientId, clientSecret, codeVerifier }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  if (codeVerifier !== null) form.set('code_verifier', codeVerifier);

  const { status, payload } = await requestJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (status !== 200 || typeof payload.access_token !== 'string') {
    throw new UnauthorizedError('That sign in attempt could not be completed. Try again.');
  }

  return payload.access_token;
}

/**
 * Reads the identity behind an access token.
 *
 * @param {string} accessToken Access token from the exchange.
 * @returns {Promise<{providerUserId: string, username: string, email: string|null}>}
 * @throws {UnauthorizedError} When the identity cannot be read.
 */
async function readIdentity(accessToken) {
  const { status, payload } = await requestJson(USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (status !== 200 || payload.id === undefined) {
    throw new UnauthorizedError('That sign in attempt could not be completed. Try again.');
  }

  return {
    providerUserId: String(payload.id),
    username: typeof payload.username === 'string' ? payload.username : null,
    email: typeof payload.email === 'string' ? payload.email : null,
  };
}

module.exports = {
  name: 'gitlab',
  label: 'GitLab',
  authorizeUrl: AUTHORIZE_URL,
  scope: 'read_user',
  supportsPkce: true,
  pkceMethod: 'S256',
  requiresNetwork: true,
  exchangeCode,
  readIdentity,
};
