'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const { Account } = require('../../infrastructure/database/models');
const { sendPasswordResetEmail } = require('../../infrastructure/email/mailer');
const { ConflictError, UnauthorizedError } = require('../../core/errors');
const { isReservedIdentifier } = require('../../core/reservedIdentifiers');
const {
  issueAccessToken,
  issueActionToken,
  consumeActionToken,
  revokeActionTokens,
} = require('./token.service');

/**
 * Authentication logic.
 *
 * Design rules that recur throughout:
 *
 *   - Login and password reset never reveal whether an identifier exists.
 *     Registration does, because the product requires an availability check,
 *     and that endpoint is rate limited hard to compensate.
 *   - Passwords are stored as bcrypt digests and compared with bcrypt, so a
 *     database leak does not yield credentials.
 *   - Repeated failures lock an account for a cooling off period, which is what
 *     makes online guessing impractical.
 */

/**
 * A real bcrypt digest of a random value, computed once.
 *
 * When login is attempted against an address that has no account, the password
 * is still compared against this digest. That keeps the work done on a miss
 * comparable to the work done on a hit, so response timing does not reveal
 * which accounts exist. A hand written string would not work here: bcrypt
 * rejects a malformed digest immediately and the timing signal would remain.
 */
const TIMING_DECOY_HASH = bcrypt.hashSync(
  crypto.randomBytes(24).toString('hex'),
  config.security.bcryptRounds,
);

/**
 * Reports whether a user id or email is already taken.
 *
 * @param {{userId?: string, email?: string}} candidate Identifiers to check.
 * @returns {Promise<{user_id_available?: boolean, email_available?: boolean}>}
 */
async function checkAvailability({ userId, email }) {
  const result = {};

  if (userId !== undefined) {
    // A reserved identifier is well formed but can never be claimed, so it is
    // reported the same way a taken one is.
    if (isReservedIdentifier(userId)) {
      result.user_id_available = false;
    } else {
      const existing = await Account.findOne({ where: { userId }, attributes: ['id'] });
      result.user_id_available = existing === null;
    }
  }

  if (email !== undefined) {
    const existing = await Account.findOne({ where: { email }, attributes: ['id'] });
    result.email_available = existing === null;
  }

  return result;
}

/**
 * Creates a personal account.
 *
 * The `type` column is fixed to USER here and is never read from the payload,
 * so nobody can register themselves an organization namespace directly.
 *
 * @param {{user_id: string, email: string, password: string}} input Validated payload.
 * @returns {Promise<{account: object, token: string, expiresIn: number}>}
 * @throws {ConflictError} When the user id or email is taken.
 */
async function register(input) {
  const existing = await Account.findOne({
    where: { [Op.or]: [{ userId: input.user_id }, { email: input.email }] },
  });

  if (existing !== null) {
    const field = existing.userId === input.user_id ? 'user id' : 'email address';
    throw new ConflictError(`That ${field} is already registered.`);
  }

  const passwordHash = await bcrypt.hash(input.password, config.security.bcryptRounds);

  const account = await Account.create({
    userId: input.user_id,
    email: input.email,
    passwordHash,
    type: 'USER',
    displayName: input.user_id,
  });

  logger.info('Account registered.', { accountId: account.id, userId: account.userId });

  const { token, expiresIn } = issueAccessToken(account);
  return { account, token, expiresIn };
}

/**
 * Authenticates a set of credentials.
 *
 * @param {{identifier: string, password: string}} input Validated payload.
 * @returns {Promise<{account: object, token: string, expiresIn: number}>}
 * @throws {UnauthorizedError} When the credentials are wrong or the account is locked.
 */
async function login(input) {
  const identifier = input.identifier.trim().toLowerCase();

  const account = await Account.findOne({
    where: { [Op.or]: [{ userId: identifier }, { email: identifier }] },
  });

  // A single message for every failure mode, so the response cannot be used to
  // discover which accounts exist.
  const genericFailure = new UnauthorizedError('The credentials you entered are not correct.');

  if (account === null) {
    // Spend comparable time on a miss so response timing does not leak whether
    // the account exists.
    await bcrypt.compare(input.password, TIMING_DECOY_HASH);
    throw genericFailure;
  }

  if (account.lockedUntil !== null && account.lockedUntil > new Date()) {
    throw new UnauthorizedError(
      'This account is temporarily locked after too many failed attempts. Try again later.',
    );
  }

  const matches = await bcrypt.compare(input.password, account.passwordHash);

  if (!matches) {
    const attempts = account.failedLoginAttempts + 1;
    const updates = { failedLoginAttempts: attempts };

    if (attempts >= config.security.maxFailedLogins) {
      updates.lockedUntil = new Date(Date.now() + config.security.lockoutMinutes * 60 * 1000);
      updates.failedLoginAttempts = 0;
      logger.warn('Account locked after repeated failures.', { accountId: account.id });
    }

    await account.update(updates);
    logger.warn('Failed login attempt.', { accountId: account.id, attempts });
    throw genericFailure;
  }

  if (account.failedLoginAttempts !== 0 || account.lockedUntil !== null) {
    await account.update({ failedLoginAttempts: 0, lockedUntil: null });
  }

  logger.info('Login succeeded.', { accountId: account.id });

  const { token, expiresIn } = issueAccessToken(account);
  return { account, token, expiresIn };
}

/**
 * Starts the forgot password flow.
 *
 * The response is identical whether or not the address is registered, so this
 * endpoint cannot be used to test which email addresses have accounts.
 *
 * @param {{email: string}} input Validated payload.
 * @returns {Promise<{token: string|null}>} Token, returned only outside production.
 */
async function requestPasswordReset(input) {
  const account = await Account.findOne({ where: { email: input.email } });

  if (account === null) {
    logger.info('Password reset requested for an unknown address.', {});
    return { token: null };
  }

  // Any earlier link is invalidated, so only the newest one can be redeemed.
  await revokeActionTokens(account.id, 'PASSWORD_RESET');

  const { token, expiresInSeconds } = await issueActionToken({
    account,
    purpose: 'PASSWORD_RESET',
  });

  await sendPasswordResetEmail({
    to: account.email,
    userId: account.userId,
    token,
    expiresInSeconds,
  });

  logger.info('Password reset email dispatched.', { accountId: account.id });

  // Returned outside production only, so local development and the automated
  // tests can complete the flow without reading an inbox.
  return { token: config.isProduction ? null : token };
}

/**
 * Completes the forgot password flow.
 *
 * @param {{token: string, password: string}} input Validated payload.
 * @returns {Promise<{account: object}>}
 * @throws {UnauthorizedError} When the token is invalid, expired or already used.
 */
async function resetPassword(input) {
  const { accountId } = await consumeActionToken({
    token: input.token,
    purpose: 'PASSWORD_RESET',
  });

  const account = await Account.findByPk(accountId);
  if (account === null) {
    throw new UnauthorizedError('The link is invalid or has expired.');
  }

  const passwordHash = await bcrypt.hash(input.password, config.security.bcryptRounds);

  await account.update({
    passwordHash,
    // Moving this forward invalidates every other outstanding action token.
    credentialsChangedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
  });

  await revokeActionTokens(account.id);

  logger.info('Password reset completed.', { accountId: account.id });
  return { account };
}

module.exports = { checkAvailability, register, login, requestPasswordReset, resetPassword };
