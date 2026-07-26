'use strict';

const logger = require('../../core/logger');
const { TranslationKey, Translation } = require('../../infrastructure/database/models');
const { MASTER_LANG_CODE } = require('../../infrastructure/database/models/file');
const { computeTextHash } = require('../../core/textHash');
const { createZipArchive } = require('../../core/zip');
const { NotFoundError, BadRequestError } = require('../../core/errors');
const {
  buildLocaleDocument,
  buildAllLocaleDocuments,
  listAvailableLocales,
  findStaleTranslations,
} = require('./translationExport');
const { buildConsistencyReport } = require('./translationConsistency');

/**
 * Translation editing and export.
 *
 * Backs the editor page, where a reviewer reads the English master alongside
 * every generated locale and corrects anything the model got wrong.
 */

/**
 * Name every archive download is offered under.
 *
 * Fixed rather than derived from the file, so a person collecting locale sets
 * from several files gets a predictable name and a build script can rely on it.
 */
const ARCHIVE_FILENAME = 'langs.zip';

/**
 * Loads a file's keys with their translations attached.
 *
 * @param {string} fileId File identifier.
 * @returns {Promise<Array<object>>} Translation key model instances.
 */
async function loadTranslationKeys(fileId) {
  return TranslationKey.findAll({
    where: { fileId },
    include: [{ model: Translation, as: 'translations' }],
    order: [['key_name', 'ASC']],
  });
}

/**
 * Builds the editor payload for a file.
 *
 * @param {object} file File model instance.
 * @returns {Promise<object>} Editor data including stale translation warnings.
 */
async function getEditorData(file) {
  const keys = await loadTranslationKeys(file.id);

  return {
    file: file.toPublicJson(),
    master_lang_code: MASTER_LANG_CODE,
    available_locales: listAvailableLocales(keys),
    stale_translations: findStaleTranslations(keys),
    keys: keys.map((key) => key.toPublicJson()),
  };
}

/**
 * Applies a manual correction to one translation.
 *
 * The row is flagged as manual so a later rerun of the pipeline leaves it
 * alone, and its `source_hash` is aligned with the key's current fingerprint so
 * the correction is not immediately reported as stale.
 *
 * @param {object} params Update parameters.
 * @param {string} params.fileId File the translation must belong to.
 * @param {string} params.translationId Translation identifier.
 * @param {string} params.translatedText Corrected text.
 * @returns {Promise<object>} Client safe translation.
 * @throws {NotFoundError} When the translation is not part of this file.
 */
async function updateTranslation({ fileId, translationId, translatedText }) {
  const translation = await Translation.findByPk(translationId, {
    include: [{ model: TranslationKey, as: 'translationKey' }],
  });

  // The file check is what stops a caller from editing a translation in another
  // namespace's project by guessing its identifier.
  if (translation === null || translation.translationKey?.fileId !== fileId) {
    throw new NotFoundError('That translation does not exist on this file.');
  }

  await translation.update({
    translatedText,
    isManual: true,
    sourceHash: translation.translationKey.textHash,
  });

  logger.info('Translation edited manually.', { translationId, fileId });
  return translation.toPublicJson();
}

/**
 * Applies a manual correction to one master string.
 *
 * This is a partial update by design: one key, named by its own identifier,
 * rather than a payload carrying the file's whole key set. A screen that saves
 * everything at once cannot tell which string a reviewer actually touched, so
 * it either restamps every fingerprint and marks the entire file stale, or it
 * has to diff the file client side and hope the diff is right.
 *
 * Editing the English master changes its fingerprint, which is exactly how the
 * translations derived from that key become visibly stale. The response says
 * whether the text really changed and which languages fell behind because of
 * it, so the caller knows whether there is anything to retranslate without
 * asking again.
 *
 * @param {object} params Update parameters.
 * @param {string} params.fileId File the key must belong to.
 * @param {string} params.keyId Translation key identifier.
 * @param {string} params.originalText Corrected master text.
 * @returns {Promise<{key: object, changed: boolean, stale_lang_codes: string[]}>}
 * @throws {NotFoundError} When the key is not part of this file.
 */
async function updateMasterText({ fileId, keyId, originalText }) {
  const key = await TranslationKey.findOne({
    where: { id: keyId, fileId },
    include: [{ model: Translation, as: 'translations' }],
  });
  if (key === null) {
    throw new NotFoundError('That key does not exist on this file.');
  }

  const textHash = computeTextHash(originalText);
  const changed = textHash !== key.textHash;

  // Writing an identical string would restamp nothing but would still burn an
  // UPDATE and an editor round trip, so the unchanged case returns early.
  if (changed) {
    await key.update({ originalText, textHash });
  }

  const staleLangCodes = (key.translations ?? [])
    .filter((translation) => translation.sourceHash !== null && translation.sourceHash !== textHash)
    .map((translation) => translation.langCode);

  logger.info('Master text edited.', { keyId, fileId, changed });

  return {
    key: key.toPublicJson(),
    changed,
    stale_lang_codes: staleLangCodes,
  };
}

/**
 * Checks that every language still matches the English master structurally.
 *
 * Run on demand rather than on every write. The check reads every key and every
 * translation of a file and compares the interpolation tokens of each pair,
 * which is precisely the work that must not happen while somebody is typing in
 * the editor.
 *
 * @param {object} params Validation parameters.
 * @param {object} params.file File model instance.
 * @param {string} [params.langCode] Single locale to check. Defaults to all.
 * @returns {Promise<object>} Consistency report.
 * @throws {BadRequestError} When the named locale is not on this file.
 */
async function validateKeyConsistency({ file, langCode }) {
  const keys = await loadTranslationKeys(file.id);
  const available = listAvailableLocales(keys).filter((code) => code !== MASTER_LANG_CODE);

  // A locale the file was asked to produce but has no rows for yet is still a
  // legitimate thing to check: the answer is that every key is missing.
  const known = new Set([...available, ...file.targetLangCodes]);

  if (langCode !== undefined && !known.has(langCode)) {
    throw new BadRequestError(
      `This file has no ${langCode} translations. Available: ${[...known].join(', ') || 'none'}.`,
    );
  }

  const report = buildConsistencyReport({
    translationKeys: keys,
    langCodes: langCode === undefined ? [...known] : [langCode],
  });

  logger.info('Key consistency validated.', {
    fileId: file.id,
    issueCount: report.issue_count,
    localeCount: report.checked_lang_codes.length,
  });

  return { file_id: file.id, ...report };
}

/**
 * Builds the downloadable document for one locale.
 *
 * @param {object} params Export parameters.
 * @param {object} params.file File model instance.
 * @param {string} params.langCode Locale to export.
 * @returns {Promise<{filename: string, document: object}>}
 * @throws {BadRequestError} When the file holds no data for that locale.
 */
async function exportLocale({ file, langCode }) {
  const keys = await loadTranslationKeys(file.id);
  const available = listAvailableLocales(keys);

  if (!available.includes(langCode)) {
    throw new BadRequestError(
      `This file has no ${langCode} translations. Available: ${available.join(', ')}.`,
    );
  }

  return {
    filename: `${langCode}.json`,
    document: buildLocaleDocument({ translationKeys: keys, langCode }),
  };
}

/**
 * Builds every locale document for a file.
 *
 * @param {object} file File model instance.
 * @returns {Promise<Record<string, object>>} Documents keyed by locale filename.
 */
async function exportAllLocales(file) {
  const keys = await loadTranslationKeys(file.id);
  return buildAllLocaleDocuments(keys);
}

/**
 * Packs every locale into one archive.
 *
 * One archive rather than one download per language, because a project with a
 * dozen locales is a dozen clicks and a dozen chances to miss one. The entry
 * names are the same locale filenames a single download produces, so unpacking
 * the archive and downloading each locale by hand give identical trees.
 *
 * @param {object} file File model instance.
 * @returns {Promise<{filename: string, archive: Buffer, entries: string[]}>}
 * @throws {BadRequestError} When the file has nothing to export yet.
 */
async function exportArchive(file) {
  const keys = await loadTranslationKeys(file.id);

  if (keys.length === 0) {
    throw new BadRequestError('This file has no translations to download yet.');
  }

  const documents = buildAllLocaleDocuments(keys);
  const entries = Object.entries(documents).map(([name, document]) => ({
    name,
    content: `${JSON.stringify(document, null, 2)}\n`,
  }));

  return {
    filename: ARCHIVE_FILENAME,
    archive: createZipArchive(entries),
    entries: entries.map((entry) => entry.name),
  };
}

module.exports = {
  getEditorData,
  updateTranslation,
  updateMasterText,
  validateKeyConsistency,
  exportLocale,
  exportAllLocales,
  exportArchive,
  loadTranslationKeys,
  ARCHIVE_FILENAME,
};
