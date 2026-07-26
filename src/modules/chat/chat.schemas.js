'use strict';

const { z } = require('zod');
const config = require('../../config');

/**
 * Assistant request schemas.
 *
 * The message may arrive as JSON or as a multipart field alongside an
 * attachment, so every field is declared as the string a multipart part
 * actually is, and coerced here rather than in a handler.
 */

const sessionIdSchema = z.string().uuid('That is not a session identifier.');

const chatMessageSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, 'Type a message.')
      .max(
        config.chat.maxPromptCharacters,
        `A message must be ${config.chat.maxPromptCharacters} characters or fewer.`,
      ),
    /** Absent starts a new conversation; present continues one. */
    session_id: sessionIdSchema.optional(),
  })
  .strict();

/** Positive integers arriving as query strings. */
const limitSchema = z.coerce.number().int().min(1).max(100);

const chatSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1, 'Type something to search for.').max(500),
    limit: limitSchema.max(20).optional(),
  })
  .strict();

const chatHistoryQuerySchema = z.object({ limit: limitSchema.optional() }).strict();

/**
 * Renaming a conversation.
 *
 * An empty string is accepted deliberately: it clears the name and puts the
 * conversation back to being listed by its opening question, which is a thing a
 * person may want and would otherwise have no way to ask for.
 */
const renameSessionSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(120, 'A conversation name must be 120 characters or fewer.'),
  })
  .strict();

const listSessionsQuerySchema = z.object({ limit: limitSchema.optional() }).strict();

const backfillEmbeddingsSchema = z
  .object({
    limit: z.number().int().min(1).max(config.chat.embeddingBackfillLimit).optional(),
  })
  .strict();

module.exports = {
  chatMessageSchema,
  chatSearchQuerySchema,
  chatHistoryQuerySchema,
  backfillEmbeddingsSchema,
  renameSessionSchema,
  listSessionsQuerySchema,
};
