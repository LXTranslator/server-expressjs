'use strict';

const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const { AiChatLog } = require('../../infrastructure/database/models');
const { getProvider } = require('../../infrastructure/ai/providers');
const { runWithKeyFallback } = require('../../infrastructure/ai/keyFallback');
const accountKeyService = require('../accountKeys/accountKey.service');

/**
 * Conversation embeddings and search.
 *
 * An embedding turns a past exchange into a vector, so "what did we decide
 * about the Thai strings" can find a conversation that never used those words.
 * It is an optimisation, and it is treated as one throughout: an account with
 * no embedding model configured chats exactly as it otherwise would, stores no
 * vectors, and searches by text instead. Nothing in the assistant fails because
 * embeddings are absent.
 *
 * That is also why generating one never blocks an answer. The exchange is
 * logged first and the vector is attached afterwards; a failed embedding leaves
 * the column empty and the row is picked up by a later backfill.
 *
 * Vectors are stored as JSON text rather than in a native vector column,
 * because the application has to run on SQLite with no configuration at all.
 * Ranking therefore happens in the process, over a bounded candidate set, which
 * is honest about what this is: good search for a personal conversation
 * history, not a vector database.
 */

/** Rows one search will rank in memory. */
const MAX_RANKED_ROWS = 300;

/**
 * Reads a stored vector.
 *
 * @param {string|null} raw Stored JSON text.
 * @returns {number[]|null} The vector, or null when it is absent or unusable.
 */
function parseVector(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(Number.isFinite)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity of two vectors.
 *
 * @param {number[]} left First vector.
 * @param {number[]} right Second vector.
 * @returns {number} Similarity between -1 and 1, or 0 when incomparable.
 */
function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * The text an exchange is embedded from.
 *
 * @param {string} prompt What the person asked.
 * @param {string} answer What the assistant replied.
 * @returns {string} Embedding input.
 */
function embeddingInput(prompt, answer) {
  return `${prompt}\n\n${answer}`.slice(0, config.chat.maxPromptCharacters);
}

/**
 * Produces one vector using the account's configured embedding credential.
 *
 * @param {object} params Parameters.
 * @param {object} params.namespace Namespace being acted in.
 * @param {object} params.actor Authenticated account.
 * @param {string} params.input Text to embed.
 * @returns {Promise<{vector: number[], model: string}|null>} Null when no
 *   embedding model is configured anywhere in the chain.
 */
async function generateEmbedding({ namespace, actor, input }) {
  const key = await accountKeyService.loadEmbeddingKey({ namespace, actor });
  if (key === null) return null;

  const provider = getProvider(key.provider);
  if (provider === null || typeof provider.embed !== 'function') return null;

  // The same fallback chain, narrowed to the credential that names an embedding
  // model. A failure here is not worth walking the whole chain: the answer is
  // already delivered and the row can be backfilled later.
  const { value, attempts } = await runWithKeyFallback({
    keys: [key],
    provider: key.provider,
    emptyMessage: 'No credential names an embedding model.',
    attempt: (candidate) =>
      provider.embed({
        apiKey: candidate.apiKey,
        model: candidate.embeddingModel,
        input,
      }),
  });

  await accountKeyService.recordKeyAttempts(attempts);
  return { vector: value, model: key.embeddingModel };
}

/**
 * Attaches a vector to a row once it has been written.
 *
 * Deliberately fire and forget. The caller has already answered the person, and
 * a failure here costs nothing that a backfill cannot recover.
 *
 * @param {object} params Parameters.
 * @param {object} params.namespace Namespace being acted in.
 * @param {object} params.actor Authenticated account.
 * @param {Promise<object>} params.written Resolves with the persisted row.
 * @param {string} params.input Text to embed.
 * @returns {Promise<void>}
 */
async function attachEmbedding({ namespace, actor, written, input }) {
  try {
    const row = await written;
    const embedding = await generateEmbedding({ namespace, actor, input });
    if (embedding === null) return;

    await row.update({
      embedding: JSON.stringify(embedding.vector),
      embeddingModel: embedding.model,
    });
  } catch (error) {
    logger.warn('A chat log could not be embedded; it will be picked up by a backfill.', {
      accountId: namespace.id,
      message: error.message,
    });
  }
}

/**
 * Searches a person's own conversations in one namespace.
 *
 * Scoped to the caller's own rows. An organization pays for the assistant, but
 * a conversation is still something a person had: an administrator can see what
 * the organization spends without being able to read what a colleague asked.
 *
 * @param {object} params Parameters.
 * @param {object} params.namespace Namespace being acted in.
 * @param {object} params.actor Authenticated account.
 * @param {string} params.query What to look for.
 * @param {number} [params.limit] Results to return.
 * @returns {Promise<{matches: Array<object>, method: string}>}
 */
async function searchLogs({ namespace, actor, query, limit = 5 }) {
  const scope = { accountId: namespace.id, userAccountId: actor.id };

  let vector = null;
  try {
    const embedding = await generateEmbedding({ namespace, actor, input: query });
    vector = embedding?.vector ?? null;
  } catch (error) {
    // Searching by text is a worse answer than searching by meaning, and a far
    // better one than no answer at all.
    logger.warn('The search query could not be embedded; falling back to text.', {
      accountId: namespace.id,
      message: error.message,
    });
  }

  if (vector !== null) {
    const candidates = await AiChatLog.findAll({
      where: { ...scope, embedding: { [Op.ne]: null } },
      order: [['id', 'DESC']],
      limit: MAX_RANKED_ROWS,
    });

    const ranked = candidates
      .map((row) => ({ row, score: cosineSimilarity(vector, parseVector(row.embedding) ?? []) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    if (ranked.length > 0) {
      return {
        method: 'EMBEDDING',
        matches: ranked.map((entry) => ({
          ...entry.row.toPublicJson(),
          score: Number(entry.score.toFixed(4)),
        })),
      };
    }
  }

  // Parameterised by Sequelize, so the query text is a value and never part of
  // the statement.
  const rows = await AiChatLog.findAll({
    where: {
      ...scope,
      [Op.or]: [
        { userPrompt: { [Op.substring]: query } },
        { aiAnswer: { [Op.substring]: query } },
      ],
    },
    order: [['id', 'DESC']],
    limit,
  });

  return { method: 'TEXT', matches: rows.map((row) => row.toPublicJson()) };
}

/**
 * Embeds past exchanges that have no vector yet.
 *
 * The point of the endpoint is the account that chatted for weeks before
 * configuring an embedding model: its history is not lost to search, it is
 * simply waiting. Bounded per call so a large history is caught up in several
 * requests rather than one that never returns.
 *
 * @param {object} params Parameters.
 * @param {object} params.namespace Namespace being acted in.
 * @param {object} params.actor Authenticated account.
 * @param {number} [params.limit] Rows to embed in this call.
 * @returns {Promise<object>} Summary of the pass.
 */
async function backfillEmbeddings({ namespace, actor, limit }) {
  const batch = Math.min(limit ?? config.chat.embeddingBackfillLimit, config.chat.embeddingBackfillLimit);

  const pending = await AiChatLog.findAll({
    where: { accountId: namespace.id, userAccountId: actor.id, embedding: null },
    order: [['id', 'ASC']],
    limit: batch,
  });

  if (pending.length === 0) {
    return { embedded: 0, failed: 0, remaining: 0, model: null, configured: true };
  }

  const key = await accountKeyService.loadEmbeddingKey({ namespace, actor });
  if (key === null) {
    return {
      embedded: 0,
      failed: 0,
      remaining: pending.length,
      model: null,
      configured: false,
    };
  }

  let embedded = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const embedding = await generateEmbedding({
        namespace,
        actor,
        input: embeddingInput(row.userPrompt, row.aiAnswer),
      });
      if (embedding === null) break;

      await row.update({
        embedding: JSON.stringify(embedding.vector),
        embeddingModel: embedding.model,
      });
      embedded += 1;
    } catch (error) {
      failed += 1;
      logger.warn('A chat log could not be embedded during a backfill.', {
        accountId: namespace.id,
        logId: row.id,
        message: error.message,
      });
    }
  }

  const remaining = await AiChatLog.count({
    where: { accountId: namespace.id, userAccountId: actor.id, embedding: null },
  });

  logger.info('Chat log embeddings backfilled.', {
    accountId: namespace.id,
    embedded,
    failed,
    remaining,
  });

  return { embedded, failed, remaining, model: key.embeddingModel, configured: true };
}

module.exports = {
  generateEmbedding,
  attachEmbedding,
  searchLogs,
  backfillEmbeddings,
  cosineSimilarity,
  embeddingInput,
};
