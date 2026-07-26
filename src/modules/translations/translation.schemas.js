'use strict';

const { z } = require('zod');
const { langCodeSchema } = require('../files/file.schemas');

/**
 * Translated text is stored and later rendered by the client.
 *
 * No HTML escaping happens here on purpose: locale strings legitimately contain
 * markup fragments and placeholders, and escaping at write time would corrupt
 * them. The client renders these values as text rather than as markup, which is
 * the correct place for that defence.
 */
const translatedTextSchema = z
  .string()
  .min(0)
  .max(10000, 'A translation must be 10000 characters or fewer.');

const updateTranslationSchema = z
  .object({ translated_text: translatedTextSchema })
  .strict();

const updateMasterTextSchema = z
  .object({
    original_text: z
      .string()
      .min(1, 'The master text cannot be empty.')
      .max(10000, 'The master text must be 10000 characters or fewer.'),
  })
  .strict();

/**
 * Keys to retranslate.
 *
 * Identifiers rather than a whole document, because the point of the endpoint
 * is that everything not named is neither sent to a provider nor rewritten. The
 * ceiling exists for the same reason every other expensive operation has one:
 * each identifier is a string sent to a paid provider in every target language.
 */
const retranslateKeysSchema = z
  .object({
    key_ids: z
      .array(z.string().uuid())
      .min(1, 'Name at least one key to retranslate.')
      .max(200, 'Retranslate 200 keys or fewer at a time.'),
    target_langs: z.array(langCodeSchema).min(1).max(50).optional(),
  })
  .strict();

/** Locale filter for the on demand consistency check. */
const consistencyQuerySchema = z.object({ lang: langCodeSchema.optional() }).strict();

module.exports = {
  updateTranslationSchema,
  updateMasterTextSchema,
  retranslateKeysSchema,
  consistencyQuerySchema,
};
