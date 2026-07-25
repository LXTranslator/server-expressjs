'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const config = require('../../config');
const logger = require('../../core/logger');
const {
  sequelize,
  File,
  TranslationKey,
  Translation,
} = require('../../infrastructure/database/models');
const { MASTER_LANG_CODE } = require('../../infrastructure/database/models/file');
const { resolveWithinDirectory } = require('../../core/filename');
const { translationPool } = require('../../workers/pool');
const projectService = require('../projects/project.service');
const { BadRequestError, ConflictError, NotFoundError } = require('../../core/errors');

/**
 * Uploaded file lifecycle.
 *
 * An upload returns as soon as the record exists; the pipeline then runs on a
 * worker thread and the record's status carries progress. Holding the HTTP
 * request open for the duration would tie up a connection for as long as the
 * provider takes, which on a large file is minutes.
 */

/** Locale codes accepted for source and target languages. */
const LANG_CODE_PATTERN = /^[a-z]{2}(_[a-z0-9]{2,8})?$/;

/**
 * Validates a locale code.
 *
 * The value reaches a generated filename, so it is checked against a strict
 * pattern rather than trusted.
 *
 * @param {string} code Candidate locale code.
 * @returns {string} The normalised code.
 * @throws {BadRequestError} When the code is malformed.
 */
function assertLangCode(code) {
  const normalized = String(code).trim().toLowerCase();
  if (!LANG_CODE_PATTERN.test(normalized)) {
    throw new BadRequestError(
      `"${code}" is not a valid locale code. Use a form such as en_us or th_th.`,
    );
  }
  return normalized;
}

/**
 * Verifies that uploaded bytes really are a JSON object.
 *
 * The extension and content type are both client controlled, so this is the
 * only check that actually proves what the file is.
 *
 * @param {Buffer} buffer Uploaded bytes.
 * @returns {string} The verified UTF-8 text.
 * @throws {BadRequestError} When the content is not a JSON object.
 */
function assertJsonObject(buffer) {
  const text = buffer.toString('utf8');

  // A byte order mark is legal in a text file but breaks JSON.parse.
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let parsed;
  try {
    parsed = JSON.parse(withoutBom);
  } catch (error) {
    throw new BadRequestError(`The file is not valid JSON: ${error.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('The translation file must contain a JSON object at its root.');
  }

  return withoutBom;
}

/**
 * Writes the verified upload to disk under a generated name.
 *
 * The client's filename is never used to build the path. A fresh UUID is, and
 * the result is proven to sit inside the storage root before anything is
 * written.
 *
 * @param {string} projectId Owning project.
 * @param {Buffer} buffer Verified bytes.
 * @returns {Promise<string|null>} Stored path, or null when storage failed.
 */
async function persistRawUpload(projectId, buffer) {
  try {
    const directory = resolveWithinDirectory(config.upload.storageDir, projectId);
    await fs.mkdir(directory, { recursive: true });

    const storedPath = resolveWithinDirectory(directory, `${crypto.randomUUID()}.json`);
    await fs.writeFile(storedPath, buffer, { mode: 0o640 });
    return storedPath;
  } catch (error) {
    // Archiving the original is useful but not essential; the parsed content is
    // already in the database, so a storage failure must not fail the upload.
    logger.error('Could not archive the uploaded file.', { projectId, message: error.message });
    return null;
  }
}

/**
 * Lists a project's files.
 *
 * @param {string} projectId Project identifier.
 * @returns {Promise<Array<object>>} Client safe files.
 */
async function listFiles(projectId) {
  const files = await File.findAll({
    where: { projectId },
    order: [['created_at', 'DESC']],
  });
  return files.map((file) => file.toPublicJson());
}

/**
 * Persists pipeline output for a file inside one transaction.
 *
 * Manual edits are preserved: a translation a human has corrected is not
 * overwritten by a rerun.
 *
 * @param {object} file File model instance.
 * @param {object} result Pipeline output.
 * @returns {Promise<void>}
 */
async function persistPipelineResult(file, result) {
  await sequelize.transaction(async (transaction) => {
    const existingKeys = await TranslationKey.findAll({
      where: { fileId: file.id },
      transaction,
    });
    const keysByName = new Map(existingKeys.map((key) => [key.keyName, key]));

    for (const incoming of result.keys) {
      let key = keysByName.get(incoming.keyName);

      if (key === undefined) {
        key = await TranslationKey.create(
          {
            fileId: file.id,
            keyName: incoming.keyName,
            originalText: incoming.originalText,
            sourceText: incoming.sourceText,
            textHash: incoming.textHash,
          },
          { transaction },
        );
      } else {
        await key.update(
          {
            originalText: incoming.originalText,
            sourceText: incoming.sourceText,
            textHash: incoming.textHash,
          },
          { transaction },
        );
      }
      keysByName.set(incoming.keyName, key);
    }

    for (const [langCode, rows] of Object.entries(result.translations)) {
      for (const row of rows) {
        const key = keysByName.get(row.keyName);
        if (key === undefined) continue;

        const existing = await Translation.findOne({
          where: { translationKeyId: key.id, langCode },
          transaction,
        });

        if (existing === null) {
          await Translation.create(
            {
              translationKeyId: key.id,
              langCode,
              translatedText: row.translatedText,
              sourceHash: row.sourceHash,
              isManual: false,
            },
            { transaction },
          );
          continue;
        }

        // A human correction outranks a machine rerun, unless the source text
        // itself changed, in which case the correction is already stale.
        const sourceChanged = existing.sourceHash !== row.sourceHash;
        if (existing.isManual && !sourceChanged) continue;

        await existing.update(
          {
            translatedText: row.translatedText,
            sourceHash: row.sourceHash,
            isManual: false,
          },
          { transaction },
        );
      }
    }

    await file.update(
      {
        status: 'READY',
        keyCount: result.keys.length,
        errorMessage: null,
        processedAt: new Date(),
      },
      { transaction },
    );
  });
}

/**
 * Runs the pipeline for a file and records the outcome.
 *
 * Never rejects: the file's status is the channel through which failure is
 * reported, because the caller has usually already responded by this point.
 *
 * @param {object} params Processing parameters.
 * @param {object} params.file File model instance.
 * @param {object} params.project Owning project.
 * @param {string} params.content Verified file content.
 * @returns {Promise<void>}
 */
async function processFile({ file, project, content }) {
  try {
    await file.update({ status: 'PROCESSING', errorMessage: null });

    const keys = await projectService.loadDecryptedKeys(project);

    const { result, attempts } = await translationPool.run({
      content,
      sourceLang: file.sourceLangCode,
      targetLangs: file.targetLangCodes,
      provider: project.aiProvider,
      model: project.aiModel,
      keys,
    });

    await persistPipelineResult(file, result);
    await projectService.recordKeyAttempts(attempts);

    logger.info('File processed.', { fileId: file.id, keyCount: result.keys.length });
  } catch (error) {
    logger.error('File processing failed.', {
      fileId: file.id,
      message: error.message,
      kind: error.kind ?? null,
    });

    await projectService.recordKeyAttempts(error.attempts ?? []);

    // The stored message is already client safe: it originates either from the
    // application's own error taxonomy or from the provider error categories.
    await file
      .update({ status: 'FAILED', errorMessage: String(error.message).slice(0, 500) })
      .catch(() => {});
  }
}

/**
 * Accepts an upload and starts processing it.
 *
 * @param {object} params Upload parameters.
 * @param {object} params.project Owning project.
 * @param {object} params.file Multer file descriptor, already sanitised.
 * @param {string} params.sourceLang Locale of the uploaded document.
 * @param {string[]} params.targetLangs Requested target locales.
 * @returns {Promise<{file: object, processing: Promise<void>}>}
 * @throws {ConflictError} When the project already has a file with that name.
 */
async function createUpload({ project, file, sourceLang, targetLangs }) {
  const content = assertJsonObject(file.buffer);

  const normalizedSource = assertLangCode(sourceLang ?? MASTER_LANG_CODE);
  const normalizedTargets = [...new Set((targetLangs ?? []).map(assertLangCode))].filter(
    (code) => code !== normalizedSource,
  );

  if (normalizedTargets.length === 0) {
    throw new BadRequestError('Select at least one target language that differs from the source.');
  }

  const duplicate = await File.findOne({
    where: { projectId: project.id, filename: file.safeName },
  });
  if (duplicate !== null) {
    throw new ConflictError('This project already has a file with that name.');
  }

  await persistRawUpload(project.id, file.buffer);

  const record = await File.create({
    projectId: project.id,
    filename: file.safeName,
    sourceLangCode: normalizedSource,
    targetLangCodes: normalizedTargets,
    status: 'PENDING',
  });

  logger.info('File uploaded.', {
    fileId: record.id,
    projectId: project.id,
    bytes: file.buffer.length,
  });

  // Started but not awaited: the response returns immediately and the client
  // polls the file's status.
  const processing = processFile({ file: record, project, content });

  return { file: record, processing };
}

/**
 * Deletes a file and everything under it.
 *
 * @param {string} projectId Owning project.
 * @param {string} fileId File identifier.
 * @returns {Promise<void>}
 * @throws {NotFoundError} When the file does not belong to the project.
 */
async function deleteFile(projectId, fileId) {
  const deleted = await File.destroy({ where: { id: fileId, projectId } });
  if (deleted === 0) {
    throw new NotFoundError('That file does not exist on this project.');
  }
  logger.info('File deleted.', { fileId, projectId });
}

module.exports = {
  listFiles,
  createUpload,
  processFile,
  deleteFile,
  assertJsonObject,
  assertLangCode,
  LANG_CODE_PATTERN,
};
