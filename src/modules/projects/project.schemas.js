'use strict';

const { z } = require('zod');

/** Project names are shown in paths and headings, so control characters are out. */
const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a project name.')
  .max(100, 'The project name must be 100 characters or fewer.')
  .regex(
    /^[A-Za-z0-9 ._-]+$/,
    'The project name may contain only letters, digits, spaces, dots, underscores and hyphens.',
  );

const createProjectSchema = z
  .object({
    name: projectNameSchema,
    description: z.string().trim().max(500).optional(),
    ai_provider: z.string().trim().max(50).optional(),
    ai_model: z.string().trim().max(100).optional(),
  })
  .strict();

const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: z.string().trim().max(500).optional(),
    ai_provider: z.string().trim().max(50).optional(),
    ai_model: z.string().trim().max(100).optional(),
  })
  .strict();

const addApiKeySchema = z
  .object({
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

const updateApiKeySchema = z
  .object({
    api_key: z.string().trim().min(8).max(500).optional(),
    label: z.string().trim().max(80).optional(),
    priority_order: z.number().int().min(1).max(1000).optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const reorderApiKeysSchema = z
  .object({ ordered_key_ids: z.array(z.string().uuid()).min(1).max(50) })
  .strict();

module.exports = {
  createProjectSchema,
  updateProjectSchema,
  addApiKeySchema,
  updateApiKeySchema,
  reorderApiKeysSchema,
};
