'use strict';

const { z } = require('zod');
const { LANG_CODE_PATTERN } = require('./file.service');

const langCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LANG_CODE_PATTERN, 'Use a locale code such as en_us, th_th or nds_de.');

/**
 * Upload metadata.
 *
 * The fields arrive as multipart text parts, so `target_langs` may be a JSON
 * array, a comma separated list, or a repeated field. All three are normalised
 * here rather than in the controller.
 */
const uploadSchema = z
  .object({
    source_lang: langCodeSchema.optional(),
    target_langs: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => {
        if (Array.isArray(value)) return value;
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // Fall through to comma separated handling.
          }
        }
        return trimmed.split(',');
      })
      .pipe(
        z
          .array(langCodeSchema)
          .min(1, 'Select at least one target language.')
          .max(50, 'Select 50 target languages or fewer.'),
      ),
  })
  .strict();

/**
 * Export query.
 *
 * `format=zip` returns every locale in one archive. It is a separate field
 * rather than a separate route so there is one download endpoint to authorise
 * and one place where the locale filter is applied.
 */
const exportQuerySchema = z
  .object({
    lang: langCodeSchema.optional(),
    format: z.enum(['json', 'zip']).optional(),
  })
  .strict();

/** Locales to add to a file that already exists. */
const addLanguagesSchema = z
  .object({
    target_langs: z
      .array(langCodeSchema)
      .min(1, 'Select at least one language to add.')
      .max(50, 'Add 50 languages or fewer at a time.'),
  })
  .strict();

module.exports = { uploadSchema, exportQuerySchema, addLanguagesSchema, langCodeSchema };
