'use strict';

const config = require('../config');
const { computeTextHash } = require('../core/textHash');
const { flattenTranslationTree } = require('../core/jsonTree');
const { BadRequestError } = require('../core/errors');
const { translateWithKeyFallback } = require('../infrastructure/ai/keyFallback');
const { MASTER_LANG_CODE } = require('../infrastructure/database/models/file');

/**
 * The translation pipeline.
 *
 * This module holds the CPU and network heavy work that must stay off the main
 * event loop: parsing the uploaded document, flattening it, hashing every
 * string, and driving the provider calls. It is written as a plain function so
 * it can be unit tested directly, and it is executed inside a worker thread in
 * production.
 *
 * It performs no database access. Everything it needs arrives in the job and
 * everything it produces is returned to the main thread, which owns
 * persistence. That keeps connection pools out of the workers and makes the
 * pipeline trivially parallel.
 */

/**
 * Splits a list into fixed size chunks so one provider call never carries an
 * unbounded payload.
 *
 * @param {Array} items Items to chunk.
 * @param {number} size Maximum chunk length.
 * @returns {Array<Array>} Chunks.
 */
function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

/**
 * Translates every string in a list, batching the provider calls.
 *
 * @param {object} params Translation parameters.
 * @param {string[]} params.texts Strings to translate.
 * @param {string} params.sourceLang Source locale code.
 * @param {string} params.targetLang Target locale code.
 * @param {object} params.job Job descriptor carrying provider, model and keys.
 * @param {Function} [params.onAttempt] Observer for credential telemetry.
 * @returns {Promise<string[]>} Translations in the input order.
 */
async function translateAll({ texts, sourceLang, targetLang, job, onAttempt }) {
  const batches = chunk(texts, config.ai.batchSize);
  const output = [];

  for (const batch of batches) {
    const result = await translateWithKeyFallback({
      providerName: job.provider,
      model: job.model,
      keys: job.keys,
      sourceLang,
      targetLang,
      texts: batch,
      onAttempt,
    });
    output.push(...result.translations);
  }

  return output;
}

/**
 * Runs the full pipeline for one uploaded file.
 *
 * Order of operations, which follows the product rule that `en_us.json` is
 * always the master:
 *
 *   1. Parse and flatten the uploaded document.
 *   2. If the upload is not English, translate it into English first. That
 *      English text becomes the master, and the uploaded text is retained as
 *      the source of record.
 *   3. Fingerprint every master string.
 *   4. Translate the master into each requested target locale.
 *
 * @param {object} job Job descriptor.
 * @param {string} job.content Raw uploaded file contents.
 * @param {string} job.sourceLang Locale of the uploaded document.
 * @param {string[]} job.targetLangs Requested target locales.
 * @param {string} job.provider Provider identifier.
 * @param {string} job.model Model identifier.
 * @param {Array<object>} job.keys Decrypted credentials sorted by priority.
 * @param {Function} [onAttempt] Observer for credential telemetry.
 * @returns {Promise<object>} Master keys and per locale translations.
 */
async function runTranslationPipeline(job, onAttempt) {
  let parsed;
  try {
    parsed = JSON.parse(job.content);
  } catch (error) {
    throw new BadRequestError(`The uploaded file is not valid JSON: ${error.message}`);
  }

  const leaves = flattenTranslationTree(parsed, {
    maxDepth: config.upload.maxJsonDepth,
    maxKeys: config.upload.maxTranslationKeys,
  });

  const sourceLang = job.sourceLang || MASTER_LANG_CODE;
  const isMasterUpload = sourceLang === MASTER_LANG_CODE;

  // Step 2: normalise to the English master.
  const masterTexts = isMasterUpload
    ? leaves.map((leaf) => leaf.originalText)
    : await translateAll({
        texts: leaves.map((leaf) => leaf.originalText),
        sourceLang,
        targetLang: MASTER_LANG_CODE,
        job,
        onAttempt,
      });

  // Step 3: fingerprint the master text.
  const keys = leaves.map((leaf, index) => ({
    keyName: leaf.keyName,
    originalText: masterTexts[index],
    sourceText: isMasterUpload ? null : leaf.originalText,
    textHash: computeTextHash(masterTexts[index]),
  }));

  // Step 4: fan out from the master. The master locale is skipped because it is
  // already the source of this step, and duplicates are collapsed.
  const targets = [...new Set(job.targetLangs)].filter(
    (lang) => typeof lang === 'string' && lang.length > 0 && lang !== MASTER_LANG_CODE,
  );

  const translations = {};
  for (const targetLang of targets) {
    const translated = await translateAll({
      texts: masterTexts,
      sourceLang: MASTER_LANG_CODE,
      targetLang,
      job,
      onAttempt,
    });

    translations[targetLang] = keys.map((key, index) => ({
      keyName: key.keyName,
      langCode: targetLang,
      translatedText: translated[index],
      sourceHash: key.textHash,
    }));
  }

  return {
    sourceLang,
    masterLang: MASTER_LANG_CODE,
    keys,
    translations,
    keyCount: keys.length,
  };
}

module.exports = { runTranslationPipeline, chunk };
