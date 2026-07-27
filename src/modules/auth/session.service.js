'use strict';

const { Op } = require('sequelize');
const logger = require('../../core/logger');
const { AccountSession } = require('../../infrastructure/database/models');
const { NotFoundError } = require('../../core/errors');

/**
 * The credentials that authenticate an account.
 *
 * One row per sign in and one per machine credential, many of both per account.
 * That plurality is the point: somebody is signed in on a laptop, a phone and a
 * second browser profile at once, and ending one of those must not touch the
 * others.
 *
 * Every function here filters by `accountId` as well as by identifier. A
 * session id is a UUID a caller could hold from anywhere, so it never selects a
 * row on its own, and revoking somebody else's session is a 404 rather than a
 * 403 for the usual reason.
 */

/**
 * How stale `last_used_at` may get before a request refreshes it.
 *
 * Writing it on every request would turn every read of every endpoint into a
 * write, for a column whose only question is "is this still in use". A minute
 * answers that question and costs almost nothing.
 */
const LAST_USED_REFRESH_MS = 60_000;

/**
 * Records a newly issued credential.
 *
 * @param {object} params Parameters.
 * @param {string} params.id Row identifier, mirroring a JWT `jti` for a session.
 * @param {string} params.accountId Owning account.
 * @param {string} params.kind `SESSION` or `API`.
 * @param {string} params.tokenHash SHA-256 digest of the issued token.
 * @param {string} [params.name] What the credential is called.
 * @param {string} [params.userAgent] Client that asked for it.
 * @param {string} [params.lastFour] Last four characters, for an API token.
 * @param {Date} [params.expiresAt] When it stops working on its own.
 * @returns {Promise<object>} The stored row.
 */
async function recordSession({
  id,
  accountId,
  kind,
  tokenHash,
  name,
  userAgent,
  lastFour,
  expiresAt,
}) {
  return AccountSession.create({
    ...(id === undefined ? {} : { id }),
    accountId,
    kind,
    tokenHash,
    name: name ?? null,
    // Truncated rather than refused: a client is free to send anything here,
    // and a long header should not be able to fail a sign in.
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : null,
    lastFour: lastFour ?? null,
    expiresAt: expiresAt ?? null,
  });
}

/**
 * Finds a live credential by its digest.
 *
 * @param {string} tokenHash SHA-256 digest of the presented token.
 * @returns {Promise<object|null>} The row, or null when absent or not live.
 */
async function findLiveByHash(tokenHash) {
  const session = await AccountSession.findOne({ where: { tokenHash } });
  if (session === null || !session.isLive()) return null;
  return session;
}

/**
 * Finds a live credential by identifier, for a token that carries its own.
 *
 * @param {string} id Row identifier.
 * @returns {Promise<object|null>} The row, or null when absent or not live.
 */
async function findLiveById(id) {
  const session = await AccountSession.findByPk(id);
  if (session === null || !session.isLive()) return null;
  return session;
}

/**
 * Marks a credential as used, no more often than the refresh interval.
 *
 * Failures are swallowed. This is bookkeeping on the authentication path, and
 * a request that is otherwise fine must not fail because a timestamp could not
 * be written.
 *
 * @param {object} session Session row.
 * @returns {Promise<void>}
 */
async function touch(session) {
  const now = Date.now();
  const last = session.lastUsedAt === null ? 0 : session.lastUsedAt.getTime();
  if (now - last < LAST_USED_REFRESH_MS) return;

  try {
    await session.update({ lastUsedAt: new Date(now) });
  } catch (error) {
    logger.warn('A session timestamp could not be refreshed.', {
      sessionId: session.id,
      message: error.message,
    });
  }
}

/**
 * Lists an account's credentials of one kind, newest first.
 *
 * Revoked rows are left out. A list of things that no longer work is not what
 * somebody is looking at this screen to see.
 *
 * @param {object} params Parameters.
 * @param {string} params.accountId Owning account.
 * @param {string} [params.kind] `SESSION` or `API`. Both when omitted.
 * @returns {Promise<Array<object>>} Client safe rows.
 */
async function listSessions({ accountId, kind }) {
  const sessions = await AccountSession.findAll({
    where: {
      accountId,
      revokedAt: null,
      ...(kind === undefined ? {} : { kind }),
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    },
    order: [['created_at', 'DESC']],
  });

  return sessions.map((session) => session.toPublicJson());
}

/**
 * Revokes one credential belonging to this account.
 *
 * @param {object} params Parameters.
 * @param {string} params.accountId Owning account.
 * @param {string} params.sessionId Credential to revoke.
 * @param {string} [params.kind] Restrict to one kind.
 * @returns {Promise<object>} The revoked row, client safe.
 * @throws {NotFoundError} When it is not this account's credential.
 */
async function revokeSession({ accountId, sessionId, kind }) {
  // Both predicates are the access check. Revoking is destructive and an
  // identifier alone must never be enough to reach somebody else's row.
  const session = await AccountSession.findOne({
    where: { id: sessionId, accountId, ...(kind === undefined ? {} : { kind }) },
  });

  if (session === null) {
    throw new NotFoundError('That credential does not exist on this account.');
  }

  // Already revoked is not an error. The caller asked for it to stop working
  // and it has stopped working.
  if (session.revokedAt === null) {
    await session.update({ revokedAt: new Date() });
    logger.info('Credential revoked.', { accountId, sessionId, kind: session.kind });
  }

  return session.toPublicJson();
}

/**
 * Revokes every credential for an account except, optionally, one.
 *
 * "Sign out everywhere else" keeps the caller signed in where they are asking
 * from, which is the only way the action is usable: the alternative signs them
 * out mid request and leaves them unable to confirm it worked.
 *
 * @param {object} params Parameters.
 * @param {string} params.accountId Owning account.
 * @param {string} [params.exceptId] Credential to keep.
 * @param {string} [params.kind] Restrict to one kind.
 * @returns {Promise<number>} How many were revoked.
 */
async function revokeAll({ accountId, exceptId, kind }) {
  const [count] = await AccountSession.update(
    { revokedAt: new Date() },
    {
      where: {
        accountId,
        revokedAt: null,
        ...(kind === undefined ? {} : { kind }),
        ...(exceptId === undefined ? {} : { id: { [Op.ne]: exceptId } }),
      },
    },
  );

  if (count > 0) {
    logger.info('Credentials revoked in bulk.', { accountId, count, kind: kind ?? 'ALL' });
  }
  return count;
}

/**
 * Deletes rows that expired or were revoked long enough ago to be uninteresting.
 *
 * @param {number} [olderThanDays] Age past which a dead row is removed.
 * @returns {Promise<number>} Rows removed.
 */
async function purgeDeadSessions(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  return AccountSession.destroy({
    where: {
      [Op.or]: [
        { revokedAt: { [Op.lt]: cutoff } },
        { expiresAt: { [Op.lt]: cutoff } },
      ],
    },
  });
}

module.exports = {
  recordSession,
  findLiveByHash,
  findLiveById,
  touch,
  listSessions,
  revokeSession,
  revokeAll,
  purgeDeadSessions,
  LAST_USED_REFRESH_MS,
};
