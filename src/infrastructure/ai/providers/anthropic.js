'use strict';

const config = require('../../../config');
const { buildSystemPrompt, buildUserPrompt, parseTranslationReply } = require('../prompt');
const {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  kindFromStatus,
  kindFromTransportError,
} = require('../providerError');

/**
 * Anthropic Messages API adapter.
 *
 * As with the OpenAI adapter the endpoint is a fixed constant, so no stored
 * value can redirect an outbound request at an internal host.
 *
 * Two details of the current Messages API are load bearing here:
 *   - `max_tokens` is required on every request.
 *   - Sampling parameters (`temperature`, `top_p`, `top_k`) are rejected with a
 *     400 by current models, so none are sent. Output is steered entirely
 *     through the system prompt.
 */
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Rough ceiling for a translated batch; the batch size keeps this comfortable. */
const MAX_OUTPUT_TOKENS = 8192;

module.exports = {
  name: 'anthropic',
  label: 'Anthropic Claude',
  defaultModel: 'claude-opus-5',
  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  requiresNetwork: true,

  /**
   * Translates a batch of strings.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Decrypted credential for this attempt.
   * @param {string} params.model Model identifier.
   * @param {string} params.sourceLang Source locale code.
   * @param {string} params.targetLang Target locale code.
   * @param {string[]} params.texts Strings to translate.
   * @returns {Promise<string[]>} Translations in the input order.
   * @throws {ProviderError} Categorised so the fallback chain can act on it.
   */
  async translateBatch({ apiKey, model, sourceLang, targetLang, texts }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Instructions stay in the system field, never concatenated with the
          // untrusted content in the user turn.
          system: buildSystemPrompt(sourceLang, targetLang),
          messages: [{ role: 'user', content: buildUserPrompt(texts) }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        kindFromTransportError(error),
        'The Anthropic request could not be completed.',
        { provider: 'anthropic', cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        kindFromStatus(response.status),
        `Anthropic responded with status ${response.status}.`,
        { status: response.status, provider: 'anthropic', cause: new Error(detail.slice(0, 300)) },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        'Anthropic returned a body that was not valid JSON.',
        { provider: 'anthropic', cause: error },
      );
    }

    // A safety decline arrives as a normal 200 with stop_reason "refusal", so
    // it has to be checked before the content array is read.
    if (payload?.stop_reason === 'refusal') {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.REQUEST,
        'Anthropic declined to translate this batch.',
        { provider: 'anthropic' },
      );
    }

    // `content` is a list of blocks; only text blocks carry the reply.
    const text = Array.isArray(payload?.content)
      ? payload.content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('')
      : '';

    try {
      return parseTranslationReply(text, texts.length);
    } catch (error) {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        `Anthropic returned an unusable reply: ${error.message}`,
        { provider: 'anthropic', cause: error },
      );
    }
  },
};
