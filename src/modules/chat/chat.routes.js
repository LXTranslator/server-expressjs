'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate, validated } = require('../../middleware/validate');
const { chatLimiter } = require('../../middleware/rateLimit');
const { optionalTranslationFile } = require('../../middleware/upload');
const chatService = require('./chat.service');
const embeddingService = require('./embedding.service');
const chatLogService = require('./chatLog.service');
const chatSessionService = require('./chatSession.service');
const schemas = require('./chat.schemas');

/**
 * Assistant routes.
 *
 * Mounted under a namespace that the parent router has already resolved, so
 * `req.namespace` and `req.namespaceRole` are established before any handler
 * here runs, and `req.account` is the authenticated person. Those three are the
 * only identities anything downstream trusts; nothing the model says about who
 * it is acting as reaches them.
 *
 * `mergeParams` is on because the namespace lives in the parent path.
 */
const router = express.Router({ mergeParams: true });

/**
 * Sends a message to the assistant.
 *
 * Accepts JSON, or multipart when a locale file is attached. The attachment
 * goes through the same verification an ordinary upload does; the difference is
 * only that its absence is not an error.
 */
router.post(
  '/',
  chatLimiter,
  // Multer runs before validation because the message field only exists once
  // the multipart body has been parsed.
  optionalTranslationFile,
  validate(schemas.chatMessageSchema),
  asyncHandler(async (req, res) => {
    const result = await chatService.converse({
      actor: req.account,
      namespace: req.namespace,
      namespaceRole: req.namespaceRole,
      message: req.body.message,
      sessionId: req.body.session_id,
      attachment: req.file ?? null,
    });

    res.json({ data: result });
  }),
);

/**
 * Lists the caller's conversations in this namespace.
 *
 * Their own and nobody else's, including inside an organization: an
 * administrator manages the credentials that pay for the assistant, which is
 * not the same as reading what a colleague asked it.
 */
router.get(
  '/sessions',
  validate(schemas.listSessionsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { limit } = validated(req, 'query');
    const sessions = await chatSessionService.listSessions({
      accountId: req.namespace.id,
      userAccountId: req.account.id,
      limit,
    });
    res.json({ data: { sessions } });
  }),
);

/** Reads back one conversation, which is always the caller's own. */
router.get(
  '/sessions/:sessionId',
  validate(schemas.chatHistoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { limit } = validated(req, 'query');
    const history = await chatService.readSession({
      actor: req.account,
      namespace: req.namespace,
      sessionId: req.params.sessionId,
      limit,
    });
    res.json({ data: history });
  }),
);

/**
 * Names a conversation.
 *
 * A conversation is named from its opening question when it starts, which makes
 * a list readable without anybody doing anything. This replaces that, and once
 * replaced nothing rewrites it: a name somebody chose outranks one derived from
 * a sentence they happened to type first.
 */
router.patch(
  '/sessions/:sessionId',
  validate(schemas.renameSessionSchema),
  asyncHandler(async (req, res) => {
    const session = await chatSessionService.renameSession({
      sessionId: req.params.sessionId,
      accountId: req.namespace.id,
      userAccountId: req.account.id,
      title: req.body.title,
    });
    res.json({ data: { session } });
  }),
);

/** Deletes a conversation and every turn in it. */
router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    await chatSessionService.deleteSession({
      sessionId: req.params.sessionId,
      accountId: req.namespace.id,
      userAccountId: req.account.id,
    });
    res.status(204).send();
  }),
);

/**
 * Searches the caller's own past conversations.
 *
 * By meaning when an embedding model is configured and the rows carry vectors,
 * by text otherwise. The response says which, so a client can explain why a
 * search found less than expected.
 */
router.get(
  '/search',
  validate(schemas.chatSearchQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, limit } = validated(req, 'query');
    const result = await embeddingService.searchLogs({
      namespace: req.namespace,
      actor: req.account,
      query: q,
      limit,
    });
    res.json({ data: result });
  }),
);

/**
 * Embeds past exchanges that have no vector yet.
 *
 * For the account that chatted before it configured an embedding model: its
 * history is not lost to search, only waiting. Bounded per call, so a long
 * history is caught up over several requests and `remaining` says how many are
 * left.
 */
router.post(
  '/embeddings',
  chatLimiter,
  validate(schemas.backfillEmbeddingsSchema),
  asyncHandler(async (req, res) => {
    const result = await embeddingService.backfillEmbeddings({
      namespace: req.namespace,
      actor: req.account,
      limit: req.body.limit,
    });
    res.json({ data: result });
  }),
);

/**
 * Reports the state of the write buffer.
 *
 * Chat logs are written asynchronously and survive a failed write in memory, so
 * "how many exchanges are waiting to be persisted" is an operational question
 * with no other answer.
 */
router.get(
  '/log_buffer',
  asyncHandler(async (req, res) => {
    res.json({ data: chatLogService.getBufferState() });
  }),
);

module.exports = router;
