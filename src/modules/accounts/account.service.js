'use strict';

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const { Account } = require('../../infrastructure/database/models');
const {
  issueActionToken,
  consumeActionToken,
  revokeActionTokens,
} = require('../auth/token.service');
const sessionService = require('../auth/session.service');
const { ConflictError, UnauthorizedError } = require('../../core/errors');

/**
 * Account settings.
 *
 * Every change here is guarded by a short lived, single use token rather than
 * by the session alone. The flow is:
 *
 *   1. Re-enter the current password to mint a SETTINGS_UPDATE token.
 *   2. Spend that token on exactly one change.
 *
 * The token lives for ten minutes and cannot be replayed, so a session left
 * open on a shared machine is not enough to take over an account, and a stolen
 * token has a narrow window and a single use.
 */

/**
 * Verifies the current password and issues a settings token.
 *
 * @param {object} account Authenticated account.
 * @param {{password: string}} input Validated payload.
 * @returns {Promise<{token: string, expires_in: number}>}
 * @throws {UnauthorizedError} When the password is wrong.
 */
async function issueSettingsToken(account, input) {
  const matches = await bcrypt.compare(input.password, account.passwordHash);
  if (!matches) {
    logger.warn('Settings token denied: wrong password.', { accountId: account.id });
    throw new UnauthorizedError('That password is not correct.');
  }

  const { token, expiresInSeconds } = await issueActionToken({
    account,
    purpose: 'SETTINGS_UPDATE',
  });

  return { token, expires_in: expiresInSeconds };
}

/**
 * Redeems a settings token and returns the account it belongs to.
 *
 * @param {object} account Authenticated account.
 * @param {string} token Raw settings token.
 * @returns {Promise<object>} The account.
 * @throws {UnauthorizedError} When the token belongs to a different session.
 */
async function redeemSettingsToken(account, token) {
  const { accountId } = await consumeActionToken({ token, purpose: 'SETTINGS_UPDATE' });

  // Binding the token to the session that presented it means a token leaked
  // from one account cannot be spent while signed in as another.
  if (accountId !== account.id) {
    throw new UnauthorizedError('That confirmation token does not belong to this session.');
  }

  return account;
}

/**
 * Changes the routing user id.
 *
 * @param {object} account Authenticated account.
 * @param {{token: string, user_id: string}} input Validated payload.
 * @returns {Promise<object>} Client safe account.
 * @throws {ConflictError} When the user id is taken.
 */
async function updateUserId(account, input) {
  await redeemSettingsToken(account, input.token);

  const existing = await Account.findOne({
    where: { userId: input.user_id, id: { [Op.ne]: account.id } },
    attributes: ['id'],
  });
  if (existing !== null) {
    throw new ConflictError('That user id is already taken.');
  }

  await account.update({ userId: input.user_id });
  logger.info('User id changed.', { accountId: account.id });
  return account.toPublicJson();
}

/**
 * Changes the email address.
 *
 * @param {object} account Authenticated account.
 * @param {{token: string, email: string}} input Validated payload.
 * @returns {Promise<object>} Client safe account.
 * @throws {ConflictError} When the address is taken.
 */
async function updateEmail(account, input) {
  await redeemSettingsToken(account, input.token);

  const existing = await Account.findOne({
    where: { email: input.email, id: { [Op.ne]: account.id } },
    attributes: ['id'],
  });
  if (existing !== null) {
    throw new ConflictError('That email address is already registered.');
  }

  await account.update({ email: input.email, credentialsChangedAt: new Date() });
  logger.info('Email address changed.', { accountId: account.id });
  return account.toPublicJson();
}

/**
 * Changes the password.
 *
 * @param {object} account Authenticated account.
 * @param {{token: string, password: string}} input Validated payload.
 * @param {string} [currentSessionId] Session making the change, which is kept.
 * @returns {Promise<{message: string}>}
 */
async function updatePassword(account, input, currentSessionId) {
  await redeemSettingsToken(account, input.token);

  const passwordHash = await bcrypt.hash(input.password, config.security.bcryptRounds);
  await account.update({
    passwordHash,
    credentialsChangedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
  });

  // Any other outstanding action token is dropped, so a reset link minted
  // before this change cannot be used afterwards.
  await revokeActionTokens(account.id);

  // And every session but this one. Changing a password is how somebody ends
  // access they no longer want; leaving other sessions alive would mean the
  // password changed and nothing else did. The session asking is kept, so the
  // person is not signed out of the screen they just used.
  const revoked = await sessionService.revokeAll({
    accountId: account.id,
    exceptId: currentSessionId,
    kind: 'SESSION',
  });

  logger.info('Password changed from settings.', { accountId: account.id, revoked });
  return {
    message:
      revoked === 0
        ? 'Your password has been updated.'
        : `Your password has been updated. ${revoked} other session${revoked === 1 ? '' : 's'} signed out.`,
  };
}

/**
 * Updates the display profile. No settings token is required, because none of
 * these fields can be used to take over the account.
 *
 * @param {object} account Authenticated account.
 * @param {{display_name?: string, description?: string, website_url?: string}} input
 *   Validated payload.
 * @returns {Promise<object>} Client safe account.
 */
async function updateProfile(account, input) {
  await account.update({
    ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.website_url === undefined ? {} : { websiteUrl: input.website_url }),
  });
  return account.toPublicJson();
}

module.exports = {
  issueSettingsToken,
  updateUserId,
  updateEmail,
  updatePassword,
  updateProfile,
};
