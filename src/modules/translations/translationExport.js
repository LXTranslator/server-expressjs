'use strict';

const { expandTranslationTree } = require('../../core/jsonTree');
const { MASTER_LANG_CODE } = require('../../infrastructure/database/models/file');

/**
 * Export format for generated locale files.
 *
 * Every leaf carries both the translated string and the 36 character
 * fingerprint of the English master text it was produced from:
 *
 * ```json
 * {
 *   "hello": {
 *     "value": "สวัสดี",
 *     "hash": "123e4567-e89b-12d3-a456-426614174000"
 *   }
 * }
 * ```
 *
 * The hash is what makes staleness detectable. A consumer re-exporting later
 * can compare the hash it holds against the current one: if they differ, the
 * English source changed and the translation needs revisiting. Without it, a
 * changed source string would silently keep its old translation.
 *
 * Nesting is preserved. A key stored as `greeting.hello` is emitted as
 * `{"greeting": {"hello": {...}}}`, matching the shape that was uploaded.
 */

/**
 * Builds the export document for one locale.
 *
 * @param {object} params Export parameters.
 * @param {Array<object>} params.translationKeys Keys with their translations loaded.
 * @param {string} params.langCode Locale to export.
 * @returns {object} Nested export document.
 */
function buildLocaleDocument({ translationKeys, langCode }) {
  const entries = [];

  for (const key of translationKeys) {
    // The master locale exports its own source text; every other locale
    // exports the stored translation for that language.
    if (langCode === MASTER_LANG_CODE) {
      entries.push({
        keyName: key.keyName,
        value: { value: key.originalText, hash: key.textHash },
      });
      continue;
    }

    const translation = (key.translations ?? []).find(
      (candidate) => candidate.langCode === langCode,
    );

    if (translation === undefined) continue;

    entries.push({
      keyName: key.keyName,
      value: { value: translation.translatedText, hash: key.textHash },
    });
  }

  return expandTranslationTree(entries);
}

/**
 * Lists every locale present for a file, master first.
 *
 * @param {Array<object>} translationKeys Keys with their translations loaded.
 * @returns {string[]} Locale codes.
 */
function listAvailableLocales(translationKeys) {
  const locales = new Set([MASTER_LANG_CODE]);
  for (const key of translationKeys) {
    for (const translation of key.translations ?? []) {
      locales.add(translation.langCode);
    }
  }
  return [...locales];
}

/**
 * Builds every locale document for a file.
 *
 * @param {Array<object>} translationKeys Keys with their translations loaded.
 * @returns {Record<string, object>} Documents keyed by locale file name.
 */
function buildAllLocaleDocuments(translationKeys) {
  const documents = {};
  for (const langCode of listAvailableLocales(translationKeys)) {
    documents[`${langCode}.json`] = buildLocaleDocument({ translationKeys, langCode });
  }
  return documents;
}

/**
 * Reports which translations have fallen behind their source text.
 *
 * A row is stale when the hash recorded at translation time no longer matches
 * the key's current fingerprint.
 *
 * @param {Array<object>} translationKeys Keys with their translations loaded.
 * @returns {Array<object>} Stale translation summaries.
 */
function findStaleTranslations(translationKeys) {
  const stale = [];
  for (const key of translationKeys) {
    for (const translation of key.translations ?? []) {
      if (translation.sourceHash !== null && translation.sourceHash !== key.textHash) {
        stale.push({
          key_name: key.keyName,
          lang_code: translation.langCode,
          translated_with_hash: translation.sourceHash,
          current_hash: key.textHash,
        });
      }
    }
  }
  return stale;
}

module.exports = {
  buildLocaleDocument,
  buildAllLocaleDocuments,
  listAvailableLocales,
  findStaleTranslations,
};
