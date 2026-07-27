'use strict';

const crypto = require('node:crypto');
const logger = require('../../core/logger');
const { AccountSession } = require('../../infrastructure/database/models');
const sessionService = require('./session.service');
const { BadRequestError } = require('../../core/errors');

/**
 * Machine credentials.
 *
 * A session token is issued by signing in with a password and lasts an hour,
 * which is right for a browser and useless for anything else. A build script, a
 * command line tool or a desktop application cannot hold a password and cannot
 * sign in again every hour, so without these the only way to use the API from a
 * machine was to post a password to the login endpoint and juggle the result.
 *
 * These are opaque random strings rather than signed tokens, and that is
 * deliberate. A JWT carries its own expiry and is verifiable without asking
 * anything, which is exactly the wrong trade for a credential that may live for
 * a year: there is no way to shorten its life once it is out. An opaque token
 * means every request consults the row, so revoking one takes effect on the
 * next call rather than whenever it would have expired.
 *
 * The prefix is not decoration. A credential that announces what it is can be
 * recognised by a secret scanner in a commit, a log or a bug report, which is
 * the difference between a leak somebody catches and one nobody notices.
 */

/** Announces what the string is, to anything scanning for leaked secrets. */
const TOKEN_PREFIX = 'lxt_';

/** Bytes of randomness behind each token. */
const TOKEN_BYTES = 32;

/**
 * Ceiling per account.
 *
 * Every token is a way in that outlives the session that made it, so the set
 * has to stay small enough that somebody can look at it and recognise all of
 * them.
 */
const MAX_TOKENS_PER_ACCOUNT = 20;

/** Longest life a token may be given, so "forever" has to be chosen knowingly. */
const MAX_EXPIRY_DAYS = 365;

/**
 * Reports whether a presented string is shaped like an API token.
 *
 * Used to decide which credential family a bearer belongs to before either is
 * checked, so a malformed one is never run through both.
 *
 * @param {string} token Raw bearer token.
 * @returns {boolean} True when it carries the prefix.
 */
function isApiToken(token) {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX);
}

/**
 * Hashes a token for storage.
 *
 * @param {string} token Raw token string.
 * @returns {string} Hex digest.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Creates a token for an account.
 *
 * The raw string is returned here and never again. Storing something that could
 * be shown a second time would mean storing something worth stealing, so what
 * is kept is a digest and the last four characters, which is enough to tell two
 * tokens apart in a list and not enough to use either.
 *
 * @param {object} params Parameters.
 * @param {object} params.account Account the token will act as.
 * @param {string} params.name What the token is for.
 * @param {number} [params.expiresInDays] Life in days. Omitted means no expiry.
 * @returns {Promise<{token: string, record: object}>} The raw token, once.
 * @throws {BadRequestError} When the account already holds the maximum.
 */
async function createApiToken({ account, name, expiresInDays }) {
  const existing = await AccountSession.count({
    where: { accountId: account.id, kind: 'API', revokedAt: null },
  });

  if (existing >= MAX_TOKENS_PER_ACCOUNT) {
    throw new BadRequestError(
      `An account may hold ${MAX_TOKENS_PER_ACCOUNT} API tokens. Revoke one before creating another.`,
    );
  }

  if (expiresInDays !== undefined && expiresInDays > MAX_EXPIRY_DAYS) {
    throw new BadRequestError(`An API token may last at most ${MAX_EXPIRY_DAYS} days.`);
  }

  // base64url so the whole string is safe in a header, a query string and a
  // shell argument without anybody having to think about quoting it.
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;

  const record = await sessionService.recordSession({
    accountId: account.id,
    kind: 'API',
    tokenHash: hashToken(token),
    name,
    lastFour: token.slice(-4),
    expiresAt:
      expiresInDays === undefined
        ? null
        : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
  });

  logger.info('API token created.', {
    accountId: account.id,
    tokenId: record.id,
    expiresInDays: expiresInDays ?? null,
  });

  return { token, record };
}

/**
 * Resolves a presented API token to its live row.
 *
 * @param {string} token Raw token string.
 * @returns {Promise<object|null>} The row, or null when it is not usable.
 */
async function resolveApiToken(token) {
  if (!isApiToken(token)) return null;
  return sessionService.findLiveByHash(hashToken(token));
}

/**
 * Lists an account's tokens, without any token material.
 *
 * @param {string} accountId Owning account.
 * @returns {Promise<Array<object>>} Client safe rows.
 */
async function listApiTokens(accountId) {
  return sessionService.listSessions({ accountId, kind: 'API' });
}

/**
 * Revokes one token belonging to this account.
 *
 * @param {object} params Parameters.
 * @param {string} params.accountId Owning account.
 * @param {string} params.tokenId Token to revoke.
 * @returns {Promise<object>} The revoked row, client safe.
 */
async function revokeApiToken({ accountId, tokenId }) {
  return sessionService.revokeSession({ accountId, sessionId: tokenId, kind: 'API' });
}

module.exports = {
  createApiToken,
  resolveApiToken,
  listApiTokens,
  revokeApiToken,
  isApiToken,
  hashToken,
  TOKEN_PREFIX,
  MAX_TOKENS_PER_ACCOUNT,
  MAX_EXPIRY_DAYS,
};
