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

/** Length of a mock embedding. Small, because nothing here needs to be big. */
const MOCK_EMBEDDING_DIMENSIONS = 32;

/**
 * Rejects a credential the fixtures mark as broken, or no credential at all.
 *
 * Shared by every entry point so the fallback chain behaves identically
 * whichever capability is being exercised.
 *
 * @param {string} apiKey Credential supplied for this attempt.
 * @returns {void}
 * @throws {ProviderError} When the key is a failure fixture or is absent.
 */
function assertUsableKey(apiKey) {
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
}

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

/**
 * Directive the mock understands inside a user message.
 *
 * The offline provider has to be able to drive the agent loop, or the loop is
 * only ever exercised against a real vendor and therefore never in CI. A
 * message may name the tool it wants called:
 *
 * ```
 * #call:list_projects
 * #call:add_languages {"target_langs":["th_th"],"all_projects":true}
 * ```
 *
 * The call is emitted once. When the transcript already carries a result for
 * that tool, the mock answers in text instead, so a loop always terminates.
 * Nothing outside a message written by the caller can trigger this, and a real
 * provider ignores the syntax entirely.
 */
const CALL_DIRECTIVE = /#call:([a-z_]{1,40})(?:[ \t]+(\{[\s\S]*?\}))?/;

/**
 * Estimates token usage from character counts.
 *
 * Four characters to the token is the rule of thumb every vendor's own
 * documentation uses for English, and the number only has to be stable for the
 * accounting in the chat log to mean something.
 *
 * @param {Array<object>} messages Conversation sent to the model.
 * @param {string} reply Text produced.
 * @returns {number} Estimated total tokens.
 */
function estimateTokens(messages, reply) {
  const promptCharacters = messages.reduce(
    (total, message) => total + String(message.content ?? '').length,
    0,
  );
  return Math.ceil((promptCharacters + reply.length) / 4);
}

module.exports = {
  name: 'mock',
  label: 'Built in Mock (offline)',
  defaultModel: 'mock-small',
  models: ['mock-small', 'mock-large'],
  embeddingModels: ['mock-embedding'],
  defaultEmbeddingModel: 'mock-embedding',
  supportsCaching: false,
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
    assertUsableKey(apiKey);
    return texts.map((text) => pseudoTranslate(text, targetLang));
  },

  /**
   * Answers one assistant turn offline.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Credential, checked against failure fixtures.
   * @param {Array<object>} params.messages Conversation so far.
   * @param {Array<object>} [params.tools] Declared tools.
   * @returns {Promise<{text: string|null, toolCalls: Array<object>, usage: object}>}
   * @throws {ProviderError} When a failure fixture key is supplied.
   */
  async chat({ apiKey, messages, tools }) {
    assertUsableKey(apiKey);

    const declared = new Set((tools ?? []).map((tool) => tool.name));
    const answered = new Set(
      messages.filter((message) => message.role === 'tool').map((message) => message.name),
    );

    // Only a message the caller actually wrote can ask for a tool. A tool
    // result is data, and the mock reads no directive out of one, which is the
    // same boundary a real provider is asked to hold.
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const directive = CALL_DIRECTIVE.exec(String(lastUser?.content ?? ''));

    if (directive !== null && declared.has(directive[1]) && !answered.has(directive[1])) {
      let parsedArguments = {};
      if (directive[2] !== undefined) {
        try {
          parsedArguments = JSON.parse(directive[2]);
        } catch {
          parsedArguments = {};
        }
      }

      return {
        text: null,
        toolCalls: [
          {
            id: `mock_call_${answered.size + 1}`,
            name: directive[1],
            arguments: parsedArguments,
          },
        ],
        usage: { totalTokens: estimateTokens(messages, directive[0]) },
      };
    }

    const summary =
      answered.size === 0
        ? `[mock] ${String(lastUser?.content ?? '').slice(0, 200)}`
        : `[mock] Done. Tools used: ${[...answered].join(', ')}.`;

    return {
      text: summary,
      toolCalls: [],
      usage: { totalTokens: estimateTokens(messages, summary) },
    };
  },

  /**
   * Produces a deterministic pseudo embedding.
   *
   * Real similarity is not the point: the vector has to be stable, the same
   * length every time, and different for different text, so that storing,
   * backfilling and ranking can all be exercised with nothing configured.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Credential, checked against failure fixtures.
   * @param {string} params.input Text to embed.
   * @returns {Promise<number[]>} Unit length vector.
   * @throws {ProviderError} When a failure fixture key is supplied.
   */
  async embed({ apiKey, input }) {
    assertUsableKey(apiKey);

    const digest = crypto.createHash('sha256').update(String(input), 'utf8').digest();
    const vector = [];
    for (let index = 0; index < MOCK_EMBEDDING_DIMENSIONS; index += 1) {
      // Centred on zero so two unrelated strings are not automatically similar.
      vector.push((digest[index % digest.length] - 128) / 128);
    }

    const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
  },
};

module.exports.FAILURE_FIXTURES = FAILURE_FIXTURES;
