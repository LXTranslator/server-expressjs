'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const totp = require('../../core/totp');
const { AccountMfa, AccountRecoveryCode, MfaChallenge } = require('../../infrastructure/database/models');
const { encryptSecret, decryptSecret } = require('../../infrastructure/crypto/secretBox');
const { BadRequestError, ConflictError, UnauthorizedError } = require('../../core/errors');
const { hashToken } = require('./token.service');

/**
 * The second factor: enrolment, verification, recovery codes and the login
 * challenge that sits between a correct password and a session.
 *
 * Three rules run through all of it:
 *
 *   - A secret is written encrypted and read back in exactly one function, so
 *     there is one place to look when asking where it can leak.
 *   - Every single use record is spent with a conditional UPDATE rather than a
 *     read followed by a write, so two concurrent requests cannot both win. It
 *     is the same idiom `consumeActionToken` uses, for the same reason.
 *   - A code that has been accepted once is never accepted again, even inside
 *     the window that still considers it current.
 */

/** Codes issued when a factor is confirmed, and again on regeneration. */
const RECOVERY_CODE_COUNT = 10;

/**
 * Characters in one recovery code, drawn from the alphabet below.
 *
 * Twenty characters over a thirty character alphabet is a little under a
 * hundred bits, which is far past the point where guessing is a strategy. The
 * length is a legibility decision, not a security one: five groups of four is
 * what fits on a printed line and what somebody can read back over a phone.
 */
const RECOVERY_CODE_LENGTH = 20;

/** Characters per hyphen separated group. */
const RECOVERY_GROUP_SIZE = 4;

/** Bytes behind a login challenge string. */
const CHALLENGE_BYTES = 32;

/** Guesses allowed against one challenge before it is spent. */
const MAX_CHALLENGE_ATTEMPTS = 5;

/**
 * Base32 without the four characters people transcribe wrongly.
 *
 * `I` and `1`, `O` and `0`, `L` and `1`, `U` and `V` are the pairs that turn a
 * recovery code copied off a printed sheet into a support request.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * Strips the formatting a person types back out of a recovery code.
 *
 * Generation and verification must normalize identically or nothing ever
 * matches, so both go through here.
 *
 * @param {string} code Submitted code.
 * @returns {string} Normalized code.
 */
function normalizeRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Reports whether a submitted value looks like a recovery code rather than a TOTP code.
 *
 * The two arrive on the same field because asking somebody to declare which
 * kind of code they are holding is a question they should not have to answer.
 * A TOTP code is six digits; a recovery code is longer and carries letters, so
 * the shapes cannot be confused.
 *
 * @param {string} code Submitted value.
 * @returns {boolean} True when it should be checked against the recovery codes.
 */
function looksLikeRecoveryCode(code) {
  return totp.normalizeCode(code) === null;
}

/**
 * Generates one recovery code.
 *
 * `randomInt` rather than `randomBytes` modulo the alphabet length. Thirty does
 * not divide two hundred and fifty six, so the modulo would make the first
 * sixteen characters measurably likelier than the rest, and would also throw
 * away most of the entropy the bytes carried. `randomInt` rejection samples,
 * which costs nothing here and is simply correct.
 *
 * @returns {string} A grouped, human readable code.
 */
function generateRecoveryCode() {
  const groups = [];

  for (let index = 0; index < RECOVERY_CODE_LENGTH; index += RECOVERY_GROUP_SIZE) {
    let group = '';
    for (let position = 0; position < RECOVERY_GROUP_SIZE; position += 1) {
      group += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    groups.push(group);
  }

  return groups.join('-');
}

/**
 * Reads the second factor row for an account, secret included.
 *
 * The single place the ciphertext is read. Everywhere else uses the default
 * scope, which excludes it.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<object|null>} The row, or null.
 */
async function findWithSecret(accountId) {
  return AccountMfa.scope('withSecret').findOne({ where: { accountId } });
}

/**
 * Reports the account's second factor state.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<{enabled: boolean, enrolled: boolean, confirmed_at: Date|null,
 *   recovery_codes_remaining: number}>}
 */
async function describe(accountId) {
  const record = await AccountMfa.findOne({ where: { accountId } });

  if (record === null) {
    return { enabled: false, enrolled: false, confirmed_at: null, recovery_codes_remaining: 0 };
  }

  const remaining = await AccountRecoveryCode.count({
    where: { accountId, consumedAt: null },
  });

  return {
    enabled: record.confirmedAt !== null,
    enrolled: true,
    confirmed_at: record.confirmedAt,
    recovery_codes_remaining: remaining,
  };
}

/**
 * Reports whether an account must answer a challenge before it gets a session.
 *
 * Enrolled but unconfirmed does not count. Somebody who abandoned an enrolment
 * halfway must not be locked out by a secret they never proved they hold.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<boolean>} True when a confirmed factor exists.
 */
async function isEnabled(accountId) {
  const record = await AccountMfa.findOne({
    where: { accountId, confirmedAt: { [Op.ne]: null } },
  });
  return record !== null;
}

/**
 * Begins enrolment, replacing any unconfirmed attempt.
 *
 * The secret and its URI are returned exactly once, here. Nothing reads them
 * back afterwards, so a person who loses the enrolment screen starts again
 * rather than asking for the same secret a second time.
 *
 * @param {object} account Authenticated account.
 * @returns {Promise<{secret: string, otpauth_uri: string}>}
 * @throws {ConflictError} When a confirmed factor already exists.
 */
async function beginEnrolment(account) {
  const existing = await AccountMfa.findOne({ where: { accountId: account.id } });

  if (existing !== null && existing.confirmedAt !== null) {
    throw new ConflictError('This account already has a second factor. Remove it before adding another.');
  }

  const { base32 } = totp.generateSecret();
  const envelope = encryptSecret(base32);

  if (existing === null) {
    await AccountMfa.create({ accountId: account.id, secret: envelope });
  } else {
    // An abandoned enrolment is replaced rather than reused, so a secret that
    // may have been shown on a shared screen cannot be revived later.
    await existing.update({ secret: envelope, lastUsedCounter: null, lastVerifiedAt: null });
  }

  logger.info('Second factor enrolment started.', { accountId: account.id });

  return {
    secret: base32,
    otpauth_uri: totp.buildOtpauthUri({
      issuer: config.mfa.issuerName,
      accountName: account.userId,
      base32Secret: base32,
    }),
  };
}

/**
 * Spends a time step, refusing one that has already been used.
 *
 * Drift keeps a code current for up to ninety seconds, so acceptance has to be
 * recorded. The comparison is a conditional UPDATE rather than a read and a
 * write, because two requests arriving with the same code must not both pass.
 *
 * @param {string} accountId Account identifier.
 * @param {number} counter Time step that matched.
 * @returns {Promise<boolean>} True when the step was still unspent.
 */
async function spendCounter(accountId, counter) {
  const [updated] = await AccountMfa.update(
    { lastUsedCounter: counter, lastVerifiedAt: new Date() },
    {
      where: {
        accountId,
        [Op.or]: [{ lastUsedCounter: null }, { lastUsedCounter: { [Op.lt]: counter } }],
      },
    },
  );

  return updated === 1;
}

/**
 * Checks a TOTP code against the stored secret and spends its time step.
 *
 * @param {string} accountId Account identifier.
 * @param {string} code Submitted code.
 * @returns {Promise<boolean>} True when the code was valid and unspent.
 */
async function verifyTotp(accountId, code) {
  const record = await findWithSecret(accountId);
  if (record === null) return false;

  const secret = totp.base32Decode(decryptSecret(record.secret));
  const { valid, counter } = totp.verifyCode(secret, code);
  if (!valid) return false;

  return spendCounter(accountId, counter);
}

/**
 * Spends one recovery code.
 *
 * @param {string} accountId Account identifier.
 * @param {string} code Submitted code.
 * @returns {Promise<boolean>} True when the code existed and was unspent.
 */
async function verifyRecoveryCode(accountId, code) {
  const codeHash = hashToken(normalizeRecoveryCode(code));

  const [updated] = await AccountRecoveryCode.update(
    { consumedAt: new Date() },
    { where: { accountId, codeHash, consumedAt: null } },
  );

  if (updated !== 1) return false;

  const remaining = await AccountRecoveryCode.count({ where: { accountId, consumedAt: null } });
  if (remaining <= 2) {
    logger.warn('Recovery codes nearly exhausted.', { accountId, remaining });
  }

  return true;
}

/**
 * Checks whichever kind of code was submitted.
 *
 * @param {string} accountId Account identifier.
 * @param {string} code Submitted value.
 * @returns {Promise<boolean>} True when it was accepted.
 */
async function verifyAnyCode(accountId, code) {
  if (looksLikeRecoveryCode(code)) {
    return verifyRecoveryCode(accountId, code);
  }
  return verifyTotp(accountId, code);
}

/**
 * Replaces every recovery code with a fresh set.
 *
 * All of them, never a top up. A partial regeneration leaves somebody holding
 * two printed sheets with no way to tell which one still works.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<string[]>} The new codes, returned exactly once.
 */
async function regenerateRecoveryCodes(accountId) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  await AccountRecoveryCode.destroy({ where: { accountId } });
  await AccountRecoveryCode.bulkCreate(
    codes.map((code) => ({ accountId, codeHash: hashToken(normalizeRecoveryCode(code)) })),
  );

  logger.info('Recovery codes regenerated.', { accountId, count: codes.length });

  return codes;
}

/**
 * Confirms enrolment by proving a code, and issues the recovery codes.
 *
 * @param {object} account Authenticated account.
 * @param {{code: string}} input Validated payload.
 * @returns {Promise<{recovery_codes: string[]}>}
 * @throws {BadRequestError} When there is nothing to confirm.
 * @throws {UnauthorizedError} When the code is wrong.
 */
async function confirmEnrolment(account, input) {
  const record = await AccountMfa.findOne({ where: { accountId: account.id } });

  if (record === null) {
    throw new BadRequestError('Start the second factor setup before confirming a code.');
  }
  if (record.confirmedAt !== null) {
    throw new ConflictError('This account already has a second factor.');
  }

  // A recovery code cannot confirm an enrolment: none exist yet, and the point
  // is to prove the authenticator holds the secret.
  const accepted = await verifyTotp(account.id, input.code);
  if (!accepted) {
    logger.warn('Second factor confirmation failed.', { accountId: account.id });
    throw new UnauthorizedError('That code is not correct.');
  }

  await record.update({ confirmedAt: new Date() });
  const codes = await regenerateRecoveryCodes(account.id);

  logger.info('Second factor enabled.', { accountId: account.id });

  return { recovery_codes: codes };
}

/**
 * Removes the second factor and every recovery code with it.
 *
 * @param {object} account Authenticated account.
 * @returns {Promise<void>}
 * @throws {BadRequestError} When no factor is enrolled.
 */
async function disable(account) {
  const record = await AccountMfa.findOne({ where: { accountId: account.id } });
  if (record === null) {
    throw new BadRequestError('This account has no second factor to remove.');
  }

  await AccountRecoveryCode.destroy({ where: { accountId: account.id } });
  await MfaChallenge.destroy({ where: { accountId: account.id } });
  await record.destroy();

  logger.info('Second factor removed.', { accountId: account.id });
}

/**
 * Mints a login challenge for an account that has proved its password.
 *
 * @param {object} account Account whose first factor is satisfied.
 * @returns {Promise<{challengeToken: string, expiresIn: number}>}
 */
async function issueChallenge(account) {
  const challengeToken = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');
  const expiresIn = config.security.shortLivedTokenTtlSeconds;

  await MfaChallenge.create({
    accountId: account.id,
    tokenHash: hashToken(challengeToken),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });

  return { challengeToken, expiresIn };
}

/**
 * Loads a live challenge by the string presented.
 *
 * @param {string} challengeToken Raw challenge string.
 * @returns {Promise<object>} The challenge row.
 * @throws {UnauthorizedError} When it cannot be redeemed.
 */
async function loadChallenge(challengeToken) {
  if (typeof challengeToken !== 'string' || challengeToken.length === 0) {
    throw new UnauthorizedError('That sign in attempt is invalid or has expired.');
  }

  const record = await MfaChallenge.findOne({
    where: {
      tokenHash: hashToken(challengeToken),
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
  });

  if (record === null) {
    throw new UnauthorizedError('That sign in attempt is invalid or has expired.');
  }
  if (record.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    throw new UnauthorizedError('That sign in attempt is invalid or has expired.');
  }

  return record;
}

/**
 * Marks a challenge spent, atomically.
 *
 * @param {object} challenge Challenge row.
 * @returns {Promise<boolean>} True when this caller was the one that spent it.
 */
async function consumeChallenge(challenge) {
  const [updated] = await MfaChallenge.update(
    { consumedAt: new Date() },
    { where: { id: challenge.id, consumedAt: null } },
  );
  return updated === 1;
}

/**
 * Records one wrong code against a challenge.
 *
 * @param {object} challenge Challenge row.
 * @returns {Promise<void>}
 */
async function registerChallengeAttempt(challenge) {
  await challenge.increment('attempts');
}

/**
 * Drops every outstanding challenge for an account.
 *
 * Called when the account locks, so a challenge minted just before the lock
 * cannot be carried through it.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<void>}
 */
async function revokeChallenges(accountId) {
  await MfaChallenge.update(
    { consumedAt: new Date() },
    { where: { accountId, consumedAt: null } },
  );
}

/**
 * Deletes challenges that are spent or long expired.
 *
 * @returns {Promise<number>} Rows removed.
 */
async function purgeExpiredChallenges() {
  return MfaChallenge.destroy({
    where: { expiresAt: { [Op.lt]: new Date() } },
  });
}

module.exports = {
  describe,
  isEnabled,
  beginEnrolment,
  confirmEnrolment,
  disable,
  verifyTotp,
  verifyRecoveryCode,
  verifyAnyCode,
  regenerateRecoveryCodes,
  normalizeRecoveryCode,
  looksLikeRecoveryCode,
  issueChallenge,
  loadChallenge,
  consumeChallenge,
  registerChallengeAttempt,
  revokeChallenges,
  purgeExpiredChallenges,
  RECOVERY_CODE_COUNT,
  MAX_CHALLENGE_ATTEMPTS,
};
