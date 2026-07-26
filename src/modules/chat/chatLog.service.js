'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const logger = require('../../core/logger');
const { AiChatLog } = require('../../infrastructure/database/models');

/**
 * Assistant conversation logging.
 *
 * Two requirements shape this module, and they pull the same way.
 *
 * The person waiting for an answer should not also wait for a row to be
 * written. The answer is already produced by the time the log is recorded, so
 * the write is handed off and the response returns; nothing about the reply
 * depends on the row existing yet.
 *
 * A log that is lost because the database blinked is worse than one written
 * late. So an entry lives in memory until a write actually succeeds. A failed
 * write leaves it there and schedules another attempt; only a successful write
 * removes it. That makes the buffer, not the database, the place where a
 * conversation exists first.
 *
 * The buffer is bounded. An unbounded one turns a database outage into a memory
 * exhaustion, which is a worse failure than the one it was protecting against.
 * At the ceiling the oldest entry is dropped and the loss is logged loudly,
 * because a silently discarded audit record is the one thing here that must
 * never happen quietly.
 */

/** Entries waiting to be written, oldest first. */
const buffer = [];

/** Timer for the next retry, so failures do not schedule one attempt each. */
let retryTimer = null;

/** True while a flush is running, so two flushes cannot write the same entry. */
let flushing = false;

/** Counters, exposed for tests and operational visibility. */
const stats = { buffered: 0, written: 0, dropped: 0, failures: 0 };

/**
 * Reports the buffer's current state.
 *
 * @returns {{pending: number, written: number, dropped: number, failures: number}}
 */
function getBufferState() {
  return {
    pending: buffer.length,
    written: stats.written,
    dropped: stats.dropped,
    failures: stats.failures,
  };
}

/**
 * Schedules the next flush attempt.
 *
 * One timer at a time: a hundred failed entries must not become a hundred
 * timers hammering a database that is already unwell.
 *
 * @returns {void}
 */
function scheduleRetry() {
  if (retryTimer !== null || buffer.length === 0) return;

  retryTimer = setTimeout(() => {
    retryTimer = null;
    flush().catch(() => {});
  }, config.chat.logRetryMs);

  // The retry must never be the reason a process refuses to exit.
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

/**
 * Writes buffered entries, keeping anything that fails.
 *
 * Entries are written oldest first and one at a time. A batch insert would be
 * faster and would also mean one bad row loses the rest of the batch, which is
 * the opposite of what this buffer is for.
 *
 * @returns {Promise<{written: number, pending: number}>} Outcome of this pass.
 */
async function flush() {
  if (flushing) return { written: 0, pending: buffer.length };
  flushing = true;

  let written = 0;

  try {
    while (buffer.length > 0) {
      const entry = buffer[0];

      try {
        const row = await AiChatLog.create(entry.values);

        // Removed only now that the row exists. Splicing before the write would
        // lose the entry on the failure this buffer exists to survive.
        buffer.shift();
        entry.resolve?.(row);
        written += 1;
        stats.written += 1;
      } catch (error) {
        stats.failures += 1;
        logger.error('A chat log could not be written and stays buffered.', {
          sessionId: entry.values.sessionId,
          pending: buffer.length,
          message: error.message,
        });
        scheduleRetry();
        break;
      }
    }
  } finally {
    flushing = false;
  }

  return { written, pending: buffer.length };
}

/**
 * Records one exchange without making the caller wait for the write.
 *
 * @param {object} values Row values for {@link AiChatLog}.
 * @returns {{ sessionId: string, flushed: Promise<void> }} The session and a
 *   promise that settles when this entry has been written, which tests await
 *   and request handlers deliberately do not.
 */
function record(values) {
  if (buffer.length >= config.chat.logBufferSize) {
    const dropped = buffer.shift();
    stats.dropped += 1;
    logger.error('The chat log buffer is full; the oldest entry was dropped.', {
      sessionId: dropped?.values?.sessionId ?? null,
      bufferSize: config.chat.logBufferSize,
      dropped: stats.dropped,
    });
    dropped?.reject?.(new Error('The chat log buffer overflowed before this entry was written.'));
  }

  let resolve;
  let reject;
  const flushed = new Promise((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  // Nobody has to be listening. Without this, a buffered entry whose write
  // fails would surface as an unhandled rejection and take the process down.
  flushed.catch(() => {});

  buffer.push({ values, resolve, reject });
  stats.buffered += 1;

  // Started, never awaited: the answer is already on its way to the caller.
  flush().catch(() => {});

  return { sessionId: values.sessionId, flushed };
}

/**
 * Reads the most recent turns of a session, oldest first.
 *
 * Bounded on purpose. Replaying an entire conversation is what makes a long
 * session cost more with every message; a window keeps the prompt, and the
 * bill, flat.
 *
 * @param {object} params Query parameters.
 * @param {string} params.sessionId Session identifier.
 * @param {string} params.accountId Namespace the session belongs to.
 * @param {string} params.userAccountId Person who owns the session.
 * @param {number} [params.limit] Turns to read.
 * @returns {Promise<Array<object>>} Rows, oldest first.
 */
async function readSessionWindow({ sessionId, accountId, userAccountId, limit }) {
  const turns = limit ?? config.chat.historyTurns;
  if (turns === 0) return [];

  // Both predicates are the access check. A session identifier is a UUID a
  // caller could hold from anywhere, so it never selects rows on its own.
  const rows = await AiChatLog.findAll({
    where: { sessionId, accountId, userAccountId },
    order: [['id', 'DESC']],
    limit: turns,
  });

  return rows.reverse();
}

/**
 * Computes the session's running token total including a new turn.
 *
 * The buffer is consulted first, because a turn recorded moments ago may not be
 * in the database yet and the total has to stay monotonic across a burst.
 *
 * @param {string} sessionId Session identifier.
 * @param {number} storedTotal Total from the last row read from the database.
 * @param {number} turnUsage Tokens this turn consumed.
 * @returns {number} New running total.
 */
function nextTotal(sessionId, storedTotal, turnUsage) {
  const buffered = buffer
    .filter((entry) => entry.values.sessionId === sessionId)
    .reduce((highest, entry) => Math.max(highest, entry.values.totalTokenUsage ?? 0), 0);

  return Math.max(storedTotal ?? 0, buffered) + turnUsage;
}

/**
 * Mints a session identifier.
 *
 * @returns {string} A new session identifier.
 */
function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Empties the buffer without writing, for test isolation only.
 *
 * @returns {void}
 */
function resetBuffer() {
  buffer.length = 0;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

module.exports = {
  record,
  flush,
  readSessionWindow,
  nextTotal,
  newSessionId,
  getBufferState,
  resetBuffer,
};
