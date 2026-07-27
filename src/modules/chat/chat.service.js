'use strict';

const config = require('../../config');
const logger = require('../../core/logger');
const { getProvider } = require('../../infrastructure/ai/providers');
const { runWithKeyFallback } = require('../../infrastructure/ai/keyFallback');
const { buildChatSystemPrompt, renderToolResult } = require('../../infrastructure/ai/chatPrompt');
const { ServiceUnavailableError } = require('../../core/errors');
const accountKeyService = require('../accountKeys/accountKey.service');
const chatLogService = require('./chatLog.service');
const chatSessionService = require('./chatSession.service');
const embeddingService = require('./embedding.service');
const { listToolDefinitions, dispatchTool } = require('./chat.tools');

/**
 * The assistant.
 *
 * One turn is a bounded loop: the model sees the conversation and the tool
 * catalogue, it either answers or asks for a tool, the tool runs, and it looks
 * again. The bound is configuration, not the model's judgement. A model that
 * keeps calling tools is stopped by `AGENTS_CHAT_REPEAT` rather than by
 * deciding it is finished, which is the difference between a loop with a
 * ceiling and a loop with a hope.
 *
 * ```
 * prompt + history + tools
 *        │
 *        ├─ model answers in text            -> done
 *        ├─ model calls "stop"               -> done, with its summary
 *        └─ model calls a tool
 *              │  the tool checks permission itself, in backend code
 *              └─ result goes back as data   -> look again, up to the ceiling
 * ```
 *
 * Three properties are worth stating because they are easy to lose later.
 *
 * **The model decides nothing about access.** Every tool re-resolves the
 * authenticated account's rights on every call. See `chat.tools.js`.
 *
 * **Every pass is paid.** The loop ceiling, the history window and the rate
 * limiter all exist because one question can otherwise become an unbounded
 * number of provider calls.
 *
 * **The answer does not wait for the database.** The exchange is handed to a
 * buffer that survives a failed write and retries, and the embedding is
 * attached afterwards. Neither is on the path of the reply.
 *
 * A turn may also come back offering downloads. Those are references to a file
 * and a format, never bytes: the client renders each as a button that fetches
 * from the download endpoint, which authorises the person clicking it. No file
 * content passes through the model, and an offer is not a permission.
 *
 * This runs on the main thread rather than on a worker, unlike the translation
 * pipeline. The pipeline is moved off because it parses and hashes, which is
 * CPU work that would stall the event loop. A chat turn is network waiting plus
 * database queries, and the tools need the connection pool that a worker is
 * deliberately kept away from.
 */

/**
 * Flattens stored turns into the neutral message shape.
 *
 * Only the prompt and the answer are replayed, never the tool traffic. The
 * intermediate calls of a past turn are not context a later turn needs, and
 * replaying them would grow the prompt with the one thing that grows fastest.
 *
 * @param {Array<object>} rows Stored log rows, oldest first.
 * @returns {Array<object>} Messages.
 */
function toHistoryMessages(rows) {
  const messages = [];
  for (const row of rows) {
    messages.push({ role: 'user', content: row.userPrompt });
    if (row.aiAnswer) messages.push({ role: 'assistant', content: row.aiAnswer });
  }
  return messages;
}

/**
 * Runs one assistant turn.
 *
 * @param {object} params Turn parameters.
 * @param {object} params.actor Authenticated account.
 * @param {object} params.namespace Namespace the turn is authorised against.
 * @param {string} params.namespaceRole Caller's role in that namespace.
 * @param {string} params.message What the person asked.
 * @param {string} [params.sessionId] Conversation to continue. A new one is
 *   started when absent.
 * @param {object|null} [params.attachment] Verified upload, when one was sent.
 * @returns {Promise<object>} The answer and what it took to produce it.
 * @throws {NotFoundError} When continuing a conversation the caller does not own.
 * @throws {ServiceUnavailableError} When no credential can answer.
 */
async function converse({ actor, namespace, namespaceRole, message, sessionId, attachment }) {
  const keys = await accountKeyService.loadDecryptedKeys({ namespace, actor });

  // Opened before anything is spent. Continuing a conversation somebody else
  // owns fails here rather than after a paid provider call.
  const sessionRecord = await chatSessionService.openSession({
    sessionId,
    accountId: namespace.id,
    userAccountId: actor.id,
    message,
  });
  const session = sessionRecord.id;

  const history = await chatLogService.readSessionWindow({
    sessionId: session,
    accountId: namespace.id,
    userAccountId: actor.id,
  });

  const messages = [
    ...toHistoryMessages(history),
    { role: 'user', content: message },
  ];

  const tools = listToolDefinitions();

  /*
   * The context a tool sees. It carries the authenticated account, which is the
   * only identity any tool trusts, and the active namespace, which `switch_
   * namespace` may replace after proving membership.
   */
  const context = {
    actor,
    namespace,
    namespaceRole,
    attachment: attachment ?? null,
    sessionId: session,
    /*
     * Downloads this turn is offering. A tool appends a reference here rather
     * than a document: the client turns each one into a button that fetches
     * from the ordinary download endpoint, which authorises the person
     * clicking it. Nothing in here is a grant, and no file content is carried.
     */
    downloads: [],
  };

  const toolCalls = [];
  let totalTokens = 0;
  let answer = null;
  let stopped = false;
  let steps = 0;

  for (let step = 0; step < config.chat.maxRepeats; step += 1) {
    steps = step + 1;

    const system = buildChatSystemPrompt({
      namespaceHandle: context.namespace.userId,
      namespaceType: context.namespace.type,
      role: context.namespaceRole,
      hasAttachment: context.attachment !== null,
      remainingSteps: config.chat.maxRepeats - step,
    });

    let turn;
    try {
      const { value, attempts } = await runWithKeyFallback({
        keys,
        emptyMessage: 'This namespace has no usable AI credential.',
        attempt: (key) => {
          const provider = getProvider(key.provider);
          if (provider === null || typeof provider.chat !== 'function') {
            throw new ServiceUnavailableError(
              `The platform "${key.provider}" cannot hold a conversation.`,
            );
          }
          return provider.chat({
            apiKey: key.apiKey,
            model: key.chatModel,
            system,
            messages,
            tools,
          });
        },
      });

      turn = value;
      await accountKeyService.recordKeyAttempts(attempts);
    } catch (error) {
      await accountKeyService.recordKeyAttempts(error.attempts ?? []);
      logger.error('The assistant could not reach a provider.', {
        accountId: namespace.id,
        sessionId: session,
        kind: error.kind ?? null,
        message: error.message,
      });
      // The provider's own wording describes a vendor, not this application, so
      // the client gets a message about this application instead.
      throw new ServiceUnavailableError(
        'The assistant is unavailable right now. Check the namespace AI credentials and try again.',
      );
    }

    totalTokens += turn.usage?.totalTokens ?? 0;

    if (turn.toolCalls.length === 0) {
      // Neither text nor a tool call is a degenerate reply. Saying so beats
      // handing the person an empty bubble and letting them guess.
      answer =
        turn.text ?? 'The assistant returned nothing usable. Try asking again.';
      break;
    }

    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      const result = await dispatchTool(call, context);

      toolCalls.push({
        name: call.name,
        ok: result.ok === true,
        ...(result.ok === true ? {} : { error: result.error }),
      });

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: renderToolResult(result),
      });

      if (call.name === 'stop' && result.ok === true) {
        stopped = true;
        answer = result.summary;
      }
    }

    if (stopped) break;
  }

  if (answer === null) {
    // The ceiling was reached. Answering from what actually happened is better
    // than spending another paid call to ask the model to summarise itself.
    const used = toolCalls.map((call) => call.name).join(', ');
    answer =
      `I stopped after ${config.chat.maxRepeats} steps without reaching an answer.` +
      (used.length > 0 ? ` Tools used: ${used}.` : '') +
      ' Ask again with a narrower request.';
  }

  const storedTotal = history.length > 0 ? history[history.length - 1].totalTokenUsage : 0;
  const runningTotal = chatLogService.nextTotal(session, storedTotal, totalTokens);

  const { flushed } = chatLogService.record({
    sessionId: session,
    // The namespace the turn was authorised against and whose credentials paid,
    // even if the model switched context part way through. What it spent is not
    // retroactively somebody else's.
    accountId: namespace.id,
    userAccountId: actor.id,
    userPrompt: message,
    aiAnswer: answer,
    tokenUsage: totalTokens,
    totalTokenUsage: runningTotal,
  });

  // After the answer exists, so a counter that fails to update costs a stale
  // number in a list rather than the reply itself.
  await chatSessionService.recordTurn({
    session: sessionRecord,
    totalTokenUsage: runningTotal,
  });

  // Started, never awaited. The answer does not wait for a vector, and an
  // account with no embedding model configured simply skips this.
  embeddingService
    .attachEmbedding({
      namespace,
      actor,
      written: flushed,
      input: embeddingService.embeddingInput(message, answer),
    })
    .catch(() => {});

  logger.info('Assistant turn completed.', {
    accountId: namespace.id,
    userAccountId: actor.id,
    sessionId: session,
    steps,
    toolCount: toolCalls.length,
    tokenUsage: totalTokens,
    stopped,
  });

  return {
    session_id: session,
    session: sessionRecord.toPublicJson(),
    answer,
    namespace: context.namespace.userId,
    tool_calls: toolCalls,
    // References, not documents. They belong to this answer rather than to the
    // stored conversation, so reopening it later shows the text without them.
    downloads: context.downloads,
    steps,
    stopped_by_tool: stopped,
    token_usage: totalTokens,
    total_token_usage: runningTotal,
  };
}

/**
 * Reads a conversation back.
 *
 * @param {object} params Query parameters.
 * @param {object} params.actor Authenticated account.
 * @param {object} params.namespace Namespace being acted in.
 * @param {string} params.sessionId Session identifier.
 * @param {number} [params.limit] Turns to read.
 * @returns {Promise<object>} History payload.
 * @throws {NotFoundError} When it is not the caller's conversation.
 */
async function readSession({ actor, namespace, sessionId, limit }) {
  // Resolved first, so reading a conversation that is not yours is a 404 rather
  // than an empty history indistinguishable from a new one.
  const session = await chatSessionService.resolveSession({
    sessionId,
    accountId: namespace.id,
    userAccountId: actor.id,
  });

  const rows = await chatLogService.readSessionWindow({
    sessionId,
    accountId: namespace.id,
    userAccountId: actor.id,
    limit: limit ?? config.chat.historyTurns,
  });

  return {
    session_id: sessionId,
    session: session.toPublicJson(),
    turn_count: rows.length,
    turns: rows.map((row) => row.toPublicJson()),
  };
}

module.exports = { converse, readSession };
