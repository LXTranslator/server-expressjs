'use strict';

const { UnauthorizedError } = require('../../../core/errors');

/**
 * An offline provider, for tests and local development.
 *
 * The AI registry carries a `mock` adapter for the same reason: the suite has
 * to build the real application and drive the real routes without reaching the
 * network, or "no configuration required" stops being true the moment somebody
 * runs the tests on a train.
 *
 * It is never registered in production. That is enforced in `index.js` rather
 * than here, so the check sits next to the registry it protects.
 *
 * The authorization code carries the identity, which is what lets a test decide
 * who is signing in:
 *
 *     "4242"                          -> id 4242, derived username and email
 *     "4242|octocat|octo@example.test" -> all three stated
 */

const AUTHORIZE_URL = 'https://mock.invalid/oauth/authorize';

/**
 * Returns the code itself as the access token.
 *
 * There is nothing to exchange, and carrying the code forward is what lets
 * `readIdentity` see which identity the test asked for.
 *
 * @param {{code: string}} params Exchange parameters.
 * @returns {Promise<string>} The access token.
 * @throws {UnauthorizedError} When the code is empty.
 */
async function exchangeCode({ code }) {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new UnauthorizedError('That sign in attempt could not be completed. Try again.');
  }
  return code.trim();
}

/**
 * Reads the identity encoded in the code.
 *
 * @param {string} accessToken Value returned by `exchangeCode`.
 * @returns {Promise<{providerUserId: string, username: string, email: string|null}>}
 * @throws {UnauthorizedError} When the identity cannot be read.
 */
async function readIdentity(accessToken) {
  const [id, username, email] = String(accessToken).split('|');

  if (!id || id.length === 0) {
    throw new UnauthorizedError('That sign in attempt could not be completed. Try again.');
  }

  return {
    providerUserId: id,
    username: username || `mock_${id}`,
    email: email || `mock_${id}@example.test`,
  };
}

module.exports = {
  name: 'mock',
  label: 'Mock provider',
  authorizeUrl: AUTHORIZE_URL,
  scope: 'read_user',
  supportsPkce: true,
  pkceMethod: 'S256',
  requiresNetwork: false,
  exchangeCode,
  readIdentity,
};
