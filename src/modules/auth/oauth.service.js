'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const { OauthState, AccountIdentity, Account } = require('../../infrastructure/database/models');
const { encryptSecret, decryptSecret } = require('../../infrastructure/crypto/secretBox');
const registry = require('../../infrastructure/oauth/providers');
const { ConflictError, NotFoundError, UnauthorizedError } = require('../../core/errors');
const { hashToken } = require('./token.service');
const authService = require('./auth.service');

/**
 * Signing in with, and linking, a github.com or gitlab.com account.
 *
 * Linking only. A provider identity nobody has linked never creates an account
 * and is never matched to one by email address: doing either would make
 * somebody's LXTranslator account reachable by whoever controls a mailbox the
 * provider happens to report, which is a weaker thing than the password it
 * would be standing in for.
 *
 * There is no cookie anywhere in this application, so the usual cookie bound
 * nonce is not available. Two things replace it, and both are load bearing:
 *
 *   - The callback for a link is authenticated, and the account that started
 *     the flow must be the account finishing it. Without that assertion a
 *     signed in visitor could be walked through a flow the attacker started
 *     and end up with the attacker's identity bound to their account.
 *   - Nothing here can be reached cross origin at all. The callback is a JSON
 *     POST, which no HTML form produces, CORS is an explicit allowlist with
 *     credentials disabled, and the credential travels in a header rather than
 *     ambiently.
 */

/** Bytes behind a state string. */
const STATE_BYTES = 32;

/** Bytes behind a PKCE verifier. 32 encodes to 43 characters, inside RFC 7636's range. */
const VERIFIER_BYTES = 32;

/**
 * Where the provider sends the browser back to.
 *
 * Derived from the client URL that already exists for password reset links, so
 * enabling a provider adds no second thing to configure. Never read from a
 * request: a caller supplied redirect is an open redirect.
 *
 * @returns {string} The callback URL.
 */
function redirectUri() {
  return `${config.app.clientUrl.replace(/\/+$/, '')}/oauth-callback`;
}

/**
 * Resolves an adapter, refusing anything unknown or unconfigured.
 *
 * A provider nobody configured answers 404 rather than 500. It is not an
 * error that the deployment chose not to enable GitHub.
 *
 * @param {string} name Provider identifier.
 * @returns {object} The adapter.
 * @throws {NotFoundError} When the provider is unknown or not configured.
 */
function requireProvider(name) {
  const provider = registry.getProvider(name);
  if (provider === null || !registry.isEnabled(name)) {
    throw new NotFoundError('That sign in provider is not available.');
  }
  return provider;
}

/**
 * Builds the PKCE pair for a provider that supports it.
 *
 * @param {object} provider Adapter.
 * @returns {{verifier: string|null, challenge: string|null, method: string|null}}
 */
function buildPkce(provider) {
  if (!provider.supportsPkce) {
    return { verifier: null, challenge: null, method: null };
  }

  const verifier = crypto.randomBytes(VERIFIER_BYTES).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge, method: provider.pkceMethod };
}

/**
 * Starts a flow and returns the URL to send the browser to.
 *
 * @param {{providerName: string, mode: 'LINK'|'LOGIN', account?: object}} params Flow parameters.
 * @returns {Promise<{authorize_url: string, expires_in: number}>}
 * @throws {NotFoundError} When the provider is not available.
 */
async function startFlow({ providerName, mode, account = null }) {
  const provider = requireProvider(providerName);
  const credentials = config.oauth[provider.name];

  const state = crypto.randomBytes(STATE_BYTES).toString('base64url');
  const pkce = buildPkce(provider);
  const expiresIn = config.security.shortLivedTokenTtlSeconds;

  await OauthState.create({
    provider: provider.name,
    mode,
    stateHash: hashToken(state),
    codeVerifier: pkce.verifier === null ? null : encryptSecret(pkce.verifier),
    accountId: mode === 'LINK' ? account.id : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });

  const query = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: provider.scope,
    state,
  });

  if (pkce.challenge !== null) {
    query.set('code_challenge', pkce.challenge);
    query.set('code_challenge_method', pkce.method);
  }

  logger.info('Provider sign in started.', { provider: provider.name, mode });

  return { authorize_url: `${provider.authorizeUrl}?${query.toString()}`, expires_in: expiresIn };
}

/**
 * Redeems a state, exactly once.
 *
 * The conditional UPDATE is what makes it single use under concurrency: two
 * callbacks racing one state produce one winner, and the loser sees the same
 * message as an expired one.
 *
 * This runs *before* the code is exchanged, not after. Consuming afterwards
 * would leave the state spendable again whenever an exchange failed, which is
 * the code injection PKCE exists to stop.
 *
 * @param {{state: string, expectedMode: 'LINK'|'LOGIN', accountId?: string|null}} params Redemption.
 * @returns {Promise<{provider: string, accountId: string|null, codeVerifier: string|null}>}
 * @throws {UnauthorizedError} When it cannot be redeemed.
 */
async function consumeState({ state, expectedMode, accountId = null }) {
  const invalid = new UnauthorizedError('That sign in attempt is invalid or has expired.');

  if (typeof state !== 'string' || state.length < 16 || state.length > 128) {
    throw invalid;
  }

  const stateHash = hashToken(state);

  const [updated] = await OauthState.update(
    { consumedAt: new Date() },
    {
      where: {
        stateHash,
        mode: expectedMode,
        consumedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
    },
  );

  if (updated !== 1) throw invalid;

  const record = await OauthState.scope('withVerifier').findOne({ where: { stateHash } });
  if (record === null) throw invalid;

  /*
   * The cookie's job, done by an assertion. In LINK mode the row was written by
   * an authenticated request, so the account that started the flow must be the
   * one finishing it. In LOGIN mode there is no account yet and the row must
   * not name one, or a link state could be spent as a sign in.
   */
  if (expectedMode === 'LINK') {
    if (accountId === null || record.accountId !== accountId) {
      logger.warn('Provider link refused: state belongs to another account.', {
        provider: record.provider,
      });
      throw new UnauthorizedError('That sign in attempt does not belong to this session.');
    }
  } else if (record.accountId !== null) {
    throw invalid;
  }

  return {
    // Read from the row, never from the request. A code minted by one provider
    // must never be presented to another provider's token endpoint.
    provider: record.provider,
    accountId: record.accountId,
    codeVerifier: record.codeVerifier === null ? null : decryptSecret(record.codeVerifier),
  };
}

/**
 * Exchanges the code and reads the identity behind it.
 *
 * The provider access token lives only inside this function. Nothing returns
 * it and nothing stores it.
 *
 * @param {{providerName: string, code: string, codeVerifier: string|null}} params Exchange.
 * @returns {Promise<{providerUserId: string, username: string|null, email: string|null}>}
 */
async function resolveIdentity({ providerName, code, codeVerifier }) {
  const provider = requireProvider(providerName);
  const credentials = config.oauth[provider.name];

  const accessToken = await provider.exchangeCode({
    code,
    redirectUri: redirectUri(),
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    codeVerifier,
  });

  return provider.readIdentity(accessToken);
}

/**
 * Completes a link, binding a provider identity to the signed in account.
 *
 * @param {{account: object, state: string, code: string}} params Callback payload.
 * @returns {Promise<object>} The stored identity.
 * @throws {ConflictError} When the identity or the provider slot is already taken.
 */
async function completeLink({ account, state, code }) {
  const redeemed = await consumeState({ state, expectedMode: 'LINK', accountId: account.id });

  const identity = await resolveIdentity({
    providerName: redeemed.provider,
    code,
    codeVerifier: redeemed.codeVerifier,
  });

  try {
    const record = await AccountIdentity.create({
      accountId: account.id,
      provider: redeemed.provider,
      providerUserId: identity.providerUserId,
      providerUsername: identity.username,
      providerEmail: identity.email,
      linkedAt: new Date(),
    });

    logger.info('Provider account linked.', {
      accountId: account.id,
      provider: redeemed.provider,
    });

    return record;
  } catch (error) {
    // Insert and catch, never check and then insert: two requests arriving
    // together would both pass a check and one would still fail here.
    if (error?.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError('That account is already linked, here or elsewhere.');
    }
    throw error;
  }
}

/**
 * Completes a sign in through a linked provider identity.
 *
 * @param {{state: string, code: string, context?: object}} params Callback payload.
 * @returns {Promise<object>} Whatever the sign in gate returned.
 * @throws {UnauthorizedError} When the identity is not linked to any account.
 */
async function completeLogin({ state, code, context = {} }) {
  const redeemed = await consumeState({ state, expectedMode: 'LOGIN' });

  const identity = await resolveIdentity({
    providerName: redeemed.provider,
    code,
    codeVerifier: redeemed.codeVerifier,
  });

  const record = await AccountIdentity.findOne({
    where: { provider: redeemed.provider, providerUserId: identity.providerUserId },
  });

  if (record === null) {
    /*
     * Refused rather than registered, and refused rather than matched on the
     * email address the provider reported. Creating an account here would make
     * one with no password; matching on email would hand an existing account to
     * whoever controls that mailbox at the provider.
     */
    logger.warn('Provider sign in refused: identity is not linked.', {
      provider: redeemed.provider,
    });
    throw new UnauthorizedError(
      'That account is not linked yet. Sign in with your password, then link it from your settings.',
    );
  }

  const account = await Account.findByPk(record.accountId);
  if (account === null) {
    throw new UnauthorizedError('That sign in attempt is invalid or has expired.');
  }

  await record.update({
    lastLoginAt: new Date(),
    // Refreshed because it is what a person recognises in the list. Never used
    // to find this row.
    providerUsername: identity.username,
    providerEmail: identity.email,
  });

  /*
   * The same gate a password sign in passes through, so a second factor is
   * demanded here too. Calling `issueAccessToken` directly would let anybody
   * holding a linked provider account walk past it.
   */
  return authService.completeSignIn(account, context);
}

/**
 * Lists an account's linked identities.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<object[]>} Public representations.
 */
async function listIdentities(accountId) {
  const records = await AccountIdentity.findAll({
    where: { accountId },
    order: [['linked_at', 'ASC']],
  });
  return records.map((record) => record.toPublicJson());
}

/**
 * Unlinks a provider from an account.
 *
 * Safe unconditionally today, because `accounts.password_hash` is not nullable
 * and so every account keeps a password. If a passwordless account ever becomes
 * possible, this is where the last credential check has to go.
 *
 * @param {string} accountId Account identifier.
 * @param {string} providerName Provider to unlink.
 * @returns {Promise<void>}
 * @throws {NotFoundError} When nothing is linked for that provider.
 */
async function unlink(accountId, providerName) {
  if (!registry.isKnownProvider(providerName)) {
    throw new NotFoundError('That sign in provider is not available.');
  }

  const removed = await AccountIdentity.destroy({
    where: { accountId, provider: providerName },
  });

  if (removed === 0) {
    throw new NotFoundError('No linked account was found for that provider.');
  }

  logger.info('Provider account unlinked.', { accountId, provider: providerName });
}

/**
 * Deletes states that have expired.
 *
 * @returns {Promise<number>} Rows removed.
 */
async function purgeExpiredStates() {
  return OauthState.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}

module.exports = {
  startFlow,
  consumeState,
  completeLink,
  completeLogin,
  listIdentities,
  unlink,
  purgeExpiredStates,
  redirectUri,
  requireProvider,
};
