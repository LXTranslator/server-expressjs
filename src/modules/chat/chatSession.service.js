'use strict';

const logger = require('../../core/logger');
const { AiChatSession } = require('../../infrastructure/database/models');
const { NotFoundError } = require('../../core/errors');

/**
 * Assistant conversations.
 *
 * A conversation is a record now, not an identifier passed around. That changes
 * two things.
 *
 * It can be named, listed and deleted, which is what a person needs to keep
 * more than one going. And it can be *owned*: continuing a conversation is a
 * lookup filtered by both the namespace and the person, so a session identifier
 * from somewhere else resolves to nothing instead of quietly accepting a turn.
 *
 * Every function here takes the namespace and the actor and filters on both.
 * None of them takes an identifier and returns what it finds.
 */

/** Longest a title may be, matching the column. */
const MAX_TITLE_LENGTH = 120;

/** Longest a derived title may run before it is cut at a word boundary. */
const DERIVED_TITLE_LENGTH = 60;

/**
 * Builds a title from the opening question.
 *
 * A conversation nobody has named still has to be findable in a list, and the
 * first thing asked is the best short description of it that exists without
 * spending a provider call to write one.
 *
 * Cut at a word boundary where there is one within reach, because a title
 * ending mid word reads as broken rather than as truncated.
 *
 * @param {string} message The opening prompt.
 * @returns {string|null} A title, or null when there is nothing to make one from.
 */
function deriveTitle(message) {
  // Newlines and runs of spaces collapse: a title is one line by definition.
  const flat = String(message ?? '')
    .replace(/\s+/gu, ' ')
    .trim();

  if (flat.length === 0) return null;
  if (flat.length <= DERIVED_TITLE_LENGTH) return flat;

  const clipped = flat.slice(0, DERIVED_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const stem = lastSpace > DERIVED_TITLE_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;

  return `${stem.trimEnd()}…`;
}

/**
 * Finds a conversation belonging to this person in this namespace.
 *
 * Both predicates are the access check. A session identifier is a UUID a caller
 * could hold from anywhere, so it never selects a row on its own.
 *
 * @param {object} params Query parameters.
 * @param {string} params.sessionId Session identifier.
 * @param {string} params.accountId Namespace being acted in.
 * @param {string} params.userAccountId The person acting.
 * @returns {Promise<object|null>} The session instance, or null.
 */
async function findSession({ sessionId, accountId, userAccountId }) {
  return AiChatSession.findOne({ where: { id: sessionId, accountId, userAccountId } });
}

/**
 * Resolves a conversation, refusing one that is not the caller's.
 *
 * 404 rather than 403 throughout: a 403 would confirm that a conversation
 * exists under an identifier the caller was only guessing at.
 *
 * @param {object} params Query parameters.
 * @param {string} params.sessionId Session identifier.
 * @param {string} params.accountId Namespace being acted in.
 * @param {string} params.userAccountId The person acting.
 * @returns {Promise<object>} The session instance.
 * @throws {NotFoundError} When it does not exist or belongs to somebody else.
 */
async function resolveSession({ sessionId, accountId, userAccountId }) {
  const session = await findSession({ sessionId, accountId, userAccountId });
  if (session === null) throw new NotFoundError('That conversation does not exist.');
  return session;
}

/**
 * Opens the conversation a turn belongs to.
 *
 * With no identifier this starts a new one. With an identifier it must be a
 * conversation the caller already owns, so a UUID picked up elsewhere cannot be
 * written into.
 *
 * The title is derived here rather than on the first write, because this is the
 * only moment that has the opening question and knows the conversation is new.
 *
 * @param {object} params Parameters.
 * @param {string} [params.sessionId] Conversation to continue.
 * @param {string} params.accountId Namespace being acted in.
 * @param {string} params.userAccountId The person acting.
 * @param {string} params.message The message about to be sent.
 * @returns {Promise<object>} The session instance.
 * @throws {NotFoundError} When continuing a conversation the caller does not own.
 */
async function openSession({ sessionId, accountId, userAccountId, message }) {
  if (sessionId !== undefined && sessionId !== null) {
    return resolveSession({ sessionId, accountId, userAccountId });
  }

  const session = await AiChatSession.create({
    accountId,
    userAccountId,
    title: deriveTitle(message),
  });

  logger.info('Assistant conversation started.', {
    accountId,
    userAccountId,
    sessionId: session.id,
  });

  return session;
}

/**
 * Records that a turn happened.
 *
 * Called after the answer is on its way, so a failure here costs a stale
 * counter rather than the reply. `last_message_at` moves and `updated_at`
 * follows, which is why the two columns are separate: renaming a conversation
 * must not reorder the list.
 *
 * @param {object} params Parameters.
 * @param {object} params.session Session instance.
 * @param {number} params.totalTokenUsage Running total after this turn.
 * @returns {Promise<void>}
 */
async function recordTurn({ session, totalTokenUsage }) {
  try {
    await session.update({
      turnCount: session.turnCount + 1,
      totalTokenUsage,
      lastMessageAt: new Date(),
    });
  } catch (error) {
    logger.error('A conversation counter could not be updated.', {
      sessionId: session.id,
      message: error.message,
    });
  }
}

/**
 * Lists this person's conversations in this namespace.
 *
 * Most recently spoken to first, and a conversation with no turns yet sorts by
 * when it was created, so a session opened and abandoned does not disappear to
 * the bottom of the list under a null.
 *
 * @param {object} params Query parameters.
 * @param {string} params.accountId Namespace being acted in.
 * @param {string} params.userAccountId The person acting.
 * @param {number} [params.limit] Rows to return.
 * @returns {Promise<Array<object>>} Client safe sessions.
 */
async function listSessions({ accountId, userAccountId, limit = 50 }) {
  const sessions = await AiChatSession.findAll({
    where: { accountId, userAccountId },
    order: [
      ['last_message_at', 'DESC'],
      ['created_at', 'DESC'],
    ],
    limit,
  });

  return sessions.map((session) => session.toPublicJson());
}

/**
 * Renames a conversation.
 *
 * An empty title clears the name rather than storing an empty string, which
 * puts the conversation back to being listed by its opening question.
 *
 * @param {object} params Parameters.
 * @param {string} params.sessionId Session identifier.
 * @param {string} params.accountId Namespace being acted in.
 * @param {string} params.userAccountId The person acting.
 * @param {string} params.title New title.
 * @returns {Promise<object>} Client safe session.
 * @throws {NotFoundError} When it is not the caller's conversation.
 */
async function renameSession({ sessionId, accountId, userAccountId, title }) {
  const session = await resolveSession({ sessionId, accountId, userAccountId });

  const trimmed = String(title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  await session.update({ title: trimmed.length === 0 ? null : trimmed });

  logger.info('Assistant conversation renamed.', { sessionId: session.id, accountId });
  return session.toPublicJson();
}

/**
 * Deletes a conversation and every turn in it.
 *
 * @param {object} params Parameters.
 * @param {string} params.sessionId Session identifier.
 * @param {string} params.accountId Namespace being acted in.
 * @param {string} params.userAccountId The person acting.
 * @returns {Promise<void>}
 * @throws {NotFoundError} When it is not the caller's conversation.
 */
async function deleteSession({ sessionId, accountId, userAccountId }) {
  const session = await resolveSession({ sessionId, accountId, userAccountId });
  await session.destroy();

  logger.info('Assistant conversation deleted.', { sessionId, accountId, userAccountId });
}

module.exports = {
  deriveTitle,
  findSession,
  resolveSession,
  openSession,
  recordTurn,
  listSessions,
  renameSession,
  deleteSession,
  MAX_TITLE_LENGTH,
};
