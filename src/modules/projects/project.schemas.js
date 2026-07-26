'use strict';

const { z } = require('zod');
const { langCodeSchema } = require('../files/file.schemas');

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

/** A description on its own, for the endpoint that changes nothing else. */
const updateProjectDescriptionSchema = z
  .object({ description: z.string().trim().max(500) })
  .strict();

/**
 * Languages to add across a namespace.
 *
 * Either an explicit list of projects or every project, never both implicitly:
 * "add Thai everywhere" and "add Thai to these three" are different enough
 * intentions that the payload should have to say which one it means.
 */
const addNamespaceLanguagesSchema = z
  .object({
    target_langs: z
      .array(langCodeSchema)
      .min(1, 'Select at least one language to add.')
      .max(50, 'Add 50 languages or fewer at a time.'),
    project_ids: z.array(z.number().int().positive()).min(1).max(50).optional(),
    all_projects: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.all_projects === true || (data.project_ids?.length ?? 0) > 0, {
    message: 'Name the projects, or set all_projects.',
    path: ['project_ids'],
  });

const reorderApiKeysSchema = z
  .object({ ordered_key_ids: z.array(z.string().uuid()).min(1).max(50) })
  .strict();

module.exports = {
  createProjectSchema,
  updateProjectSchema,
  updateProjectDescriptionSchema,
  addNamespaceLanguagesSchema,
  addApiKeySchema,
  updateApiKeySchema,
  reorderApiKeysSchema,
};
