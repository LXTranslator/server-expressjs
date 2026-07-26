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
 * @param {string[]} [job.skipKeyNames] Keys already held, to be left untouched.
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

  const allLeaves = flattenTranslationTree(parsed, {
    maxDepth: config.upload.maxJsonDepth,
    maxKeys: config.upload.maxTranslationKeys,
  });

  /*
   * Dropping a fuller document onto an existing file should cost only the new
   * strings. Filtering here rather than in the caller is what makes that true:
   * a skipped key is never sent to a provider, so merging a file of a thousand
   * keys with two new ones is two strings of quota, not a thousand. It also
   * keeps the existing translations, including manual corrections, out of reach
   * of this run entirely.
   *
   * The comparison is on key name only. A key whose master text changed is
   * still skipped, because editing an existing string is the editor's job and
   * an upload must not silently overwrite a correction.
   */
  const known = new Set(Array.isArray(job.skipKeyNames) ? job.skipKeyNames : []);
  const leaves = known.size === 0 ? allLeaves : allLeaves.filter((leaf) => !known.has(leaf.keyName));
  const skippedKeyCount = allLeaves.length - leaves.length;

  const sourceLang = job.sourceLang || MASTER_LANG_CODE;

  // Nothing new: return the empty result rather than calling a provider with an
  // empty batch, which every adapter would reject.
  if (leaves.length === 0) {
    return {
      sourceLang,
      masterLang: MASTER_LANG_CODE,
      keys: [],
      translations: {},
      keyCount: 0,
      skippedKeyCount,
    };
  }

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
    skippedKeyCount,
  };
}

module.exports = { runTranslationPipeline, chunk };
