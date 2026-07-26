'use strict';

const crypto = require('node:crypto');
const { ProviderError, PROVIDER_ERROR_KINDS } = require('../providerError');

/**
 * Offline translation provider.
 *
 * This is what makes the requirement "must work without a real key" true. It
 * performs no network calls, so the entire pipeline (upload, normalise to the
 * English master, fan out to target locales, export) can be exercised on a
 * laptop or in CI with nothing configured.
 *
 * Output is deterministic: the same input always yields the same string, which
 * makes assertions in the test suite stable.
 */

/** Locale specific decorations, purely cosmetic markers for development. */
const LOCALE_MARKS = Object.freeze({
  th_th: 'th',
  ja_jp: 'ja',
  ko_kr: 'ko',
  zh_cn: 'zh',
  fr_fr: 'fr',
  de_de: 'de',
  es_es: 'es',
  en_us: 'en',
});

/**
 * Credentials the mock accepts. Any key is accepted except the explicit failure
 * fixtures below, so a developer can paste anything and keep working.
 */
const FAILURE_FIXTURES = Object.freeze({
  /** Simulates a revoked credential, used to prove the fallback chain works. */
  mock_key_invalid: PROVIDER_ERROR_KINDS.AUTH,
  /** Simulates throttling. */
  mock_key_rate_limited: PROVIDER_ERROR_KINDS.RATE_LIMIT,
  /** Simulates an exhausted balance. */
  mock_key_quota_exceeded: PROVIDER_ERROR_KINDS.QUOTA,
  /** Simulates a vendor outage. */
  mock_key_server_error: PROVIDER_ERROR_KINDS.SERVER,
});

/**
 * Produces a stable pseudo translation for one string.
 *
 * The source text is carried through untouched and only prefixed with a locale
 * marker. That keeps every placeholder (`{name}`, `%s`, `<b>`, `:id`) intact by
 * construction, so placeholder integrity checks downstream are exercised
 * against realistic input.
 *
 * @param {string} text Source text.
 * @param {string} targetLang Target locale code.
 * @returns {string} Deterministic pseudo translation.
 */
function pseudoTranslate(text, targetLang) {
  const mark = LOCALE_MARKS[targetLang] ?? targetLang.slice(0, 2);
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${targetLang}:${text}`, 'utf8')
    .digest('hex')
    .slice(0, 4);

  return `[${mark}:${fingerprint}] ${text}`;
}

module.exports = {
  name: 'mock',
  label: 'Built in Mock (offline)',
  defaultModel: 'mock-small',
  models: ['mock-small', 'mock-large'],
  requiresNetwork: false,

  /**
   * Translates a batch of strings.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Credential, checked against failure fixtures.
   * @param {string} params.targetLang Target locale code.
   * @param {string[]} params.texts Strings to translate.
   * @returns {Promise<string[]>} Translations in the input order.
   * @throws {ProviderError} When a failure fixture key is supplied.
   */
  async translateBatch({ apiKey, targetLang, texts }) {
    const fixture = FAILURE_FIXTURES[apiKey];
    if (fixture) {
      throw new ProviderError(fixture, `Mock provider simulated a ${fixture} failure.`, {
        provider: 'mock',
      });
    }
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new ProviderError(PROVIDER_ERROR_KINDS.AUTH, 'Mock provider received no key.', {
        provider: 'mock',
      });
    }

    return texts.map((text) => pseudoTranslate(text, targetLang));
  },
};

module.exports.FAILURE_FIXTURES = FAILURE_FIXTURES;
