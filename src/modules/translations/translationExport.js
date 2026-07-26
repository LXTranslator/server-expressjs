'use strict';

const { expandTranslationTree, FORBIDDEN_KEYS } = require('../../core/jsonTree');
const { MASTER_LANG_CODE } = require('../../infrastructure/database/models/file');
const { DEFAULT_FORMAT } = require('../exportFormats/exportFormat.definitions');

/**
 * Export format for generated locale files.
 *
 * The shape of a document is chosen by a format descriptor, which belongs to
 * the owning namespace. Two descriptors ship with the application.
 *
 * `default`, the original shape, gives every leaf both the translated string
 * and the 36 character fingerprint of the English master text it was produced
 * from:
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
 * `key_value` emits the bare string instead:
 *
 * ```json
 * { "hello": "สวัสดี" }
 * ```
 *
 * which is what a localization library reads directly, at the cost of carrying
 * no fingerprint.
 *
 * Nesting is preserved in both. A key stored as `greeting.hello` is emitted as
 * `{"greeting": {"hello": ...}}`, matching the shape that was uploaded. A
 * format may turn `nested` off, which emits the dotted path as one key instead.
 */

/**
 * Builds one leaf value in the shape a format asks for.
 *
 * A null prototype is used for an object leaf so a field name can never reach
 * `Object.prototype`, even though the name was validated before it was stored.
 *
 * @param {object} format Format descriptor.
 * @param {string} text Translated or master string.
 * @param {string} hash Fingerprint of the English master text.
 * @returns {string|object} Leaf value.
 */
function buildLeafValue(format, text, hash) {
  if (format.leafShape === 'STRING') return text;

  const leaf = Object.create(null);
  leaf[format.valueField] = text;
  if (format.hashField !== null && format.hashField !== undefined) {
    leaf[format.hashField] = hash;
  }
  return leaf;
}

/**
 * Builds a document that keeps each dotted path as a single key.
 *
 * @param {Array<{keyName: string, value: *}>} entries Flattened entries.
 * @returns {object} Flat document.
 */
function buildFlatDocument(entries) {
  const root = Object.create(null);
  for (const { keyName, value } of entries) {
    if (FORBIDDEN_KEYS.has(keyName)) continue;
    root[keyName] = value;
  }
  // Round tripping through JSON drops the null prototype without losing data.
  return JSON.parse(JSON.stringify(root));
}

/**
 * Builds the export document for one locale.
 *
 * @param {object} params Export parameters.
 * @param {Array<object>} params.translationKeys Keys with their translations loaded.
 * @param {string} params.langCode Locale to export.
 * @param {object} [params.format] Format descriptor. Defaults to `default`.
 * @returns {object} Export document.
 */
function buildLocaleDocument({ translationKeys, langCode, format = DEFAULT_FORMAT }) {
  const entries = [];

  for (const key of translationKeys) {
    // The master locale exports its own source text; every other locale
    // exports the stored translation for that language.
    if (langCode === MASTER_LANG_CODE) {
      entries.push({
        keyName: key.keyName,
        value: buildLeafValue(format, key.originalText, key.textHash),
      });
      continue;
    }

    const translation = (key.translations ?? []).find(
      (candidate) => candidate.langCode === langCode,
    );

    if (translation === undefined) continue;

    entries.push({
      keyName: key.keyName,
      value: buildLeafValue(format, translation.translatedText, key.textHash),
    });
  }

  return format.nested ? expandTranslationTree(entries) : buildFlatDocument(entries);
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
 * @param {object} [format] Format descriptor. Defaults to `default`.
 * @returns {Record<string, object>} Documents keyed by locale file name.
 */
function buildAllLocaleDocuments(translationKeys, format = DEFAULT_FORMAT) {
  const documents = {};
  for (const langCode of listAvailableLocales(translationKeys)) {
    documents[`${langCode}.json`] = buildLocaleDocument({ translationKeys, langCode, format });
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
