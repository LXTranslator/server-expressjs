'use strict';

const { z } = require('zod');

/**
 * Account level AI credential payloads.
 *
 * Every schema is `.strict()`, so a field the server owns cannot be smuggled
 * in: `account_id` is taken from the resolved namespace, never from the body.
 */

const addAccountApiKeySchema = z
  .object({
    provider: z.string().trim().max(50),
    chat_model: z.string().trim().max(100).optional(),
    api_key: z
      .string()
      .trim()
      .min(8, 'That does not look like a valid API key.')
      .max(500, 'The API key is too long.'),
    label: z.string().trim().max(80).optional(),
    priority_order: z.number().int().min(1).max(1000).optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const updateAccountApiKeySchema = z
  .object({
    provider: z.string().trim().max(50).optional(),
    chat_model: z.string().trim().max(100).optional(),
    api_key: z.string().trim().min(8).max(500).optional(),
    label: z.string().trim().max(80).optional(),
    priority_order: z.number().int().min(1).max(1000).optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const reorderAccountApiKeysSchema = z
  .object({ ordered_key_ids: z.array(z.string().uuid()).min(1).max(50) })
  .strict();

module.exports = {
  addAccountApiKeySchema,
  updateAccountApiKeySchema,
  reorderAccountApiKeysSchema,
};
