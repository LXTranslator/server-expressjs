'use strict';

const { z } = require('zod');

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

module.exports = { updateTranslationSchema, updateMasterTextSchema };
