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
 * Applies a manual correction to a master string.
 *
 * Editing the English master changes its fingerprint, which is exactly how
 * every derived translation becomes visibly stale.
 *
 * @param {object} params Update parameters.
 * @param {string} params.fileId File the key must belong to.
 * @param {string} params.keyId Translation key identifier.
 * @param {string} params.originalText Corrected master text.
 * @returns {Promise<object>} Client safe translation key.
 * @throws {NotFoundError} When the key is not part of this file.
 */
async function updateMasterText({ fileId, keyId, originalText }) {
  const key = await TranslationKey.findOne({ where: { id: keyId, fileId } });
  if (key === null) {
    throw new NotFoundError('That key does not exist on this file.');
  }

  await key.update({ originalText, textHash: computeTextHash(originalText) });

  logger.info('Master text edited.', { keyId, fileId });
  return key.toPublicJson();
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
  exportLocale,
  exportAllLocales,
  exportArchive,
  loadTranslationKeys,
  ARCHIVE_FILENAME,
};
