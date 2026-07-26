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
 * OpenAI chat completions adapter.
 *
 * The endpoint is a hardcoded constant, never derived from user input or the
 * database. A project owner chooses a provider by name from a fixed registry,
 * so no request the server makes can be redirected at an internal address.
 * That closes the server side request forgery path that an editable base URL
 * would open.
 */
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

module.exports = {
  name: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-4o-mini',
  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
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
          // The credential is only ever placed in a header, never in a URL or
          // a log line.
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt(sourceLang, targetLang) },
            { role: 'user', content: buildUserPrompt(texts) },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        kindFromTransportError(error),
        'The OpenAI request could not be completed.',
        { provider: 'openai', cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // The vendor body is read for the operator log but never returned to the
      // client, since it can echo request content back.
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        kindFromStatus(response.status),
        `OpenAI responded with status ${response.status}.`,
        { status: response.status, provider: 'openai', cause: new Error(detail.slice(0, 300)) },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        'OpenAI returned a body that was not valid JSON.',
        { provider: 'openai', cause: error },
      );
    }

    const content = payload?.choices?.[0]?.message?.content;

    try {
      // The wrapper object is required by response_format; unwrap it before
      // validating the array contract.
      const parsed = JSON.parse(content);
      const items = Array.isArray(parsed) ? parsed : parsed?.translations;
      return parseTranslationReply(JSON.stringify(items), texts.length);
    } catch (error) {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        `OpenAI returned an unusable reply: ${error.message}`,
        { provider: 'openai', cause: error },
      );
    }
  },
};
