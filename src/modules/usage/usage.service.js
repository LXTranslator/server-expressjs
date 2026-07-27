'use strict';

const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const { ApiUsageLog } = require('../../infrastructure/database/models');

/**
 * The record of what has been done on an account.
 *
 * Writing a row inside the request would put a database insert on the response
 * path of every endpoint, to record something nobody is waiting to read. So
 * entries are buffered and written in batches, and the request returns without
 * knowing whether the write happened.
 *
 * This buffer is looser than the chat log's on purpose, and the difference is
 * worth stating. A chat log entry is the only copy of an exchange somebody
 * paid for, so that buffer keeps a failed entry and retries it forever. A usage
 * entry is one line of an audit trail among thousands: losing a handful to a
 * database blink is a gap, while blocking or growing without limit to avoid
 * that gap is an outage. So this one writes in batches, drops the batch if it
 * cannot be written, and says so loudly.
 */

/** Entries waiting to be written. */
const buffer = [];

/** True while a flush is running, so two cannot write the same entries. */
let flushing = false;

/** Timer for the periodic flush. */
let timer = null;

/** Counters, for tests and for the operational endpoint. */
const stats = { written: 0, dropped: 0, failures: 0 };

/**
 * How many entries may wait before the oldest are dropped.
 *
 * An unbounded buffer turns a database outage into a memory exhaustion, which
 * is a worse failure than the one it was avoiding.
 */
const MAX_BUFFERED = 2000;

/** Entries written per statement. */
const BATCH_SIZE = 200;

/** How often the buffer is drained when nothing else prompts it. */
const FLUSH_INTERVAL_MS = 5000;

/**
 * Reports the buffer's state.
 *
 * @returns {{pending: number, written: number, dropped: number, failures: number}}
 */
function getBufferState() {
  return { pending: buffer.length, ...stats };
}

/**
 * Queues one request for recording.
 *
 * Never throws. This is called from a response listener, where an exception
 * would surface as an unhandled rejection long after the request it belonged
 * to has finished.
 *
 * @param {object} entry Row values.
 * @returns {void}
 */
function record(entry) {
  try {
    if (buffer.length >= MAX_BUFFERED) {
      buffer.shift();
      stats.dropped += 1;

      // Once per thousand, because the situation that causes this causes it
      // thousands of times a second and a log line per drop makes the outage
      // worse.
      if (stats.dropped % 1000 === 1) {
        logger.error('The API usage buffer is full; the oldest entries are being dropped.', {
          bufferSize: MAX_BUFFERED,
          dropped: stats.dropped,
        });
      }
    }

    buffer.push(entry);
  } catch (error) {
    logger.warn('An API usage entry could not be queued.', { message: error.message });
  }
}

/**
 * Writes buffered entries in batches.
 *
 * A failed batch is dropped rather than retried. These rows describe requests
 * that already happened and already returned; holding them to try again would
 * trade a gap in the record for unbounded growth during exactly the incident
 * that caused the failure.
 *
 * @returns {Promise<{written: number, pending: number}>} Outcome of this pass.
 */
async function flush() {
  if (flushing || buffer.length === 0) {
    return { written: 0, pending: buffer.length };
  }
  flushing = true;

  let written = 0;

  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, BATCH_SIZE);

      try {
        await ApiUsageLog.bulkCreate(batch);
        written += batch.length;
        stats.written += batch.length;
      } catch (error) {
        stats.failures += 1;
        stats.dropped += batch.length;
        logger.error('A batch of API usage entries could not be written.', {
          count: batch.length,
          message: error.message,
        });
      }
    }
  } finally {
    flushing = false;
  }

  return { written, pending: buffer.length };
}

/**
 * Starts the periodic flush.
 *
 * Unreferenced, so a pending drain is never the reason a process refuses to
 * exit.
 *
 * @returns {void}
 */
function startFlushing() {
  if (timer !== null) return;

  timer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Stops the periodic flush and writes whatever is waiting.
 *
 * @returns {Promise<void>}
 */
async function stopFlushing() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  await flush();
}

/**
 * Reads an account's own activity, newest first.
 *
 * Always filtered by account. A usage row names a path that may itself contain
 * another account's identifiers, so this is never queried by anything a caller
 * supplied on its own.
 *
 * @param {object} params Query parameters.
 * @param {string} params.accountId Owning account.
 * @param {string} [params.sessionId] Narrow to one credential.
 * @param {number} [params.limit] Rows to return.
 * @returns {Promise<Array<object>>} Client safe rows.
 */
async function listUsage({ accountId, sessionId, limit = 100 }) {
  const rows = await ApiUsageLog.findAll({
    where: {
      accountId,
      ...(sessionId === undefined ? {} : { sessionId }),
    },
    order: [['id', 'DESC']],
    limit,
  });

  return rows.map((row) => row.toPublicJson());
}

/**
 * Summarises an account's recent activity.
 *
 * A thousand lines of log answers "what happened" and not "is anything wrong".
 * The counts do: a credential nobody remembers creating with traffic on it, or
 * a run of failures, is visible here and invisible in the list.
 *
 * @param {object} params Query parameters.
 * @param {string} params.accountId Owning account.
 * @param {number} [params.days] Window to summarise.
 * @returns {Promise<object>} Totals by credential and by outcome.
 */
async function summariseUsage({ accountId, days = 7 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await ApiUsageLog.findAll({
    where: { accountId, createdAt: { [Op.gte]: since } },
    order: [['id', 'DESC']],
    limit: 10_000,
  });

  const byCredential = new Map();
  let failed = 0;

  for (const row of rows) {
    const key = row.sessionId ?? 'unknown';
    const entry = byCredential.get(key) ?? {
      session_id: row.sessionId,
      credential_kind: row.credentialKind,
      requests: 0,
      failed: 0,
      last_used_at: row.createdAt,
    };

    entry.requests += 1;
    if (row.statusCode >= 400) {
      entry.failed += 1;
      failed += 1;
    }
    byCredential.set(key, entry);
  }

  return {
    window_days: days,
    total_requests: rows.length,
    failed_requests: failed,
    by_credential: [...byCredential.values()],
  };
}

/**
 * Deletes entries older than the retention window.
 *
 * An audit trail that grows forever is one nobody can query and eventually one
 * that fills a disk. The window is configuration rather than a constant,
 * because how long this has to be kept is a question about somebody's
 * obligations rather than about the code.
 *
 * @param {number} [days] Age past which an entry is removed.
 * @returns {Promise<number>} Rows removed.
 */
async function purgeOldUsage(days = config.usage.retentionDays) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return ApiUsageLog.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
}

/**
 * Empties the buffer without writing, for test isolation only.
 *
 * @returns {void}
 */
function resetBuffer() {
  buffer.length = 0;
  stats.written = 0;
  stats.dropped = 0;
  stats.failures = 0;
}

module.exports = {
  record,
  flush,
  startFlushing,
  stopFlushing,
  listUsage,
  summariseUsage,
  purgeOldUsage,
  getBufferState,
  resetBuffer,
  MAX_BUFFERED,
  BATCH_SIZE,
};
