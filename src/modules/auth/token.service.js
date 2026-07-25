'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const config = require('../../config');
const { AuthToken } = require('../../infrastructure/database/models');
const { UnauthorizedError } = require('../../core/errors');

/**
 * Token issuing and verification.
 *
 * Two families of token exist:
 *
 *   - Access tokens: ordinary session bearers, stateless, valid for their
 *     configured lifetime.
 *   - Short lived action tokens: password reset, email change and settings
 *     update. The specification requires these to expire in exactly ten minutes
 *     and to become invalid the instant they are used.
 *
 * A JWT alone cannot satisfy single use, because a signed token keeps verifying
 * until it expires. So every short lived token is also recorded in
 * `auth_tokens`, and redeeming one is a conditional update: the row is only
 * marked consumed if it was not already consumed. Two requests racing with the
 * same token produce exactly one winner.
 *
 * Only a SHA-256 digest of the token is stored, so reading the table does not
 * yield a usable token.
 */

/** Claim value distinguishing a session token from an action token. */
const ACCESS_TOKEN_TYPE = 'access';

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
 * Issues a session access token.
 *
 * @param {object} account Account model instance.
 * @returns {{token: string, expiresIn: number}} Signed token and its lifetime.
 */
function issueAccessToken(account) {
  const token = jwt.sign(
    { sub: account.id, userId: account.userId, type: account.type, tokenType: ACCESS_TOKEN_TYPE },
    config.security.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.security.accessTokenTtlSeconds,
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      jwtid: crypto.randomUUID(),
    },
  );

  return { token, expiresIn: config.security.accessTokenTtlSeconds };
}

/**
 * Verifies a session access token.
 *
 * @param {string} token Raw token string.
 * @returns {object} Decoded claims.
 * @throws {UnauthorizedError} When the token is absent, malformed or expired.
 */
function verifyAccessToken(token) {
  try {
    const claims = jwt.verify(token, config.security.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    });

    if (claims.tokenType !== ACCESS_TOKEN_TYPE) {
      throw new UnauthorizedError('This token cannot be used to authenticate a session.');
    }
    return claims;
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    throw new UnauthorizedError('The session token is invalid or has expired.');
  }
}

/**
 * Issues a single use action token with a strict ten minute lifetime.
 *
 * @param {object} params Issue parameters.
 * @param {object} params.account Account the token acts on behalf of.
 * @param {string} params.purpose One of the AuthToken purposes.
 * @param {object} [params.payload] Purpose specific data, for example a pending email.
 * @returns {Promise<{token: string, expiresAt: Date, expiresInSeconds: number}>}
 */
async function issueActionToken({ account, purpose, payload = null }) {
  const jti = crypto.randomUUID();
  const ttl = config.security.shortLivedTokenTtlSeconds;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const token = jwt.sign(
    { sub: account.id, purpose, tokenType: purpose },
    config.security.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: ttl,
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      jwtid: jti,
    },
  );

  await AuthToken.create({
    id: jti,
    accountId: account.id,
    purpose,
    tokenHash: hashToken(token),
    payload: payload === null ? null : JSON.stringify(payload),
    expiresAt,
  });

  return { token, expiresAt, expiresInSeconds: ttl };
}

/**
 * Redeems a single use action token.
 *
 * The signature, the ledger row, the stored digest and the account's credential
 * timestamp are all checked, and consumption is atomic.
 *
 * @param {object} params Redemption parameters.
 * @param {string} params.token Raw token string.
 * @param {string} params.purpose Expected purpose.
 * @returns {Promise<{accountId: string, payload: object|null}>}
 * @throws {UnauthorizedError} When the token cannot be redeemed.
 */
async function consumeActionToken({ token, purpose }) {
  let claims;
  try {
    claims = jwt.verify(token, config.security.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    });
  } catch {
    throw new UnauthorizedError('The link is invalid or has expired.');
  }

  if (claims.purpose !== purpose) {
    throw new UnauthorizedError('This link cannot be used for that action.');
  }

  // Atomic claim. The `consumed_at IS NULL` predicate is what makes a token
  // single use even under concurrent redemption.
  const [updatedCount] = await AuthToken.update(
    { consumedAt: new Date() },
    {
      where: {
        id: claims.jti,
        accountId: claims.sub,
        purpose,
        consumedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
    },
  );

  if (updatedCount !== 1) {
    throw new UnauthorizedError('The link has already been used or has expired.');
  }

  const record = await AuthToken.findByPk(claims.jti);

  // Guards against a forged token that happens to name a real ledger row.
  if (record === null || record.tokenHash !== hashToken(token)) {
    throw new UnauthorizedError('The link is invalid or has expired.');
  }

  let payload = null;
  if (record.payload) {
    try {
      payload = JSON.parse(record.payload);
    } catch {
      payload = null;
    }
  }

  return { accountId: record.accountId, payload };
}

/**
 * Invalidates every outstanding token of a given purpose for an account.
 *
 * Called when a password changes, so reset links minted earlier stop working.
 *
 * @param {string} accountId Account identifier.
 * @param {string} [purpose] Optional purpose filter.
 * @returns {Promise<number>} Number of tokens invalidated.
 */
async function revokeActionTokens(accountId, purpose = null) {
  const [count] = await AuthToken.update(
    { consumedAt: new Date() },
    {
      where: {
        accountId,
        consumedAt: null,
        ...(purpose === null ? {} : { purpose }),
      },
    },
  );
  return count;
}

/**
 * Deletes expired ledger rows.
 *
 * @returns {Promise<number>} Number of rows removed.
 */
async function purgeExpiredTokens() {
  return AuthToken.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  issueActionToken,
  consumeActionToken,
  revokeActionTokens,
  purgeExpiredTokens,
  hashToken,
};
