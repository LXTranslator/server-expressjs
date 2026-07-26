'use strict';

const config = require('../../../config');
const { buildSystemPrompt, buildUserPrompt, parseTranslationReply } = require('../prompt');
const { runChatCompletion, runEmbedding } = require('./openaiChat');
const {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  kindFromStatus,
  kindFromTransportError,
} = require('../providerError');

/**
 * OpenRouter adapter.
 *
 * OpenRouter is a broker rather than a model vendor: one credential and one
 * endpoint reach models from several vendors, chosen by the model identifier.
 * That is why the models below carry a vendor prefix, and why a project pointed
 * at OpenRouter can switch vendors without a new credential.
 *
 * The endpoint is a hardcoded constant, never derived from user input or the
 * database, so no request the server makes can be redirected at an internal
 * address. Only the model name varies, and it is checked against the fixed list
 * below before any call is made.
 */
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Identifies the caller in OpenRouter's dashboards. Carries no credential and
 * no deployment detail, so it is safe to send from any installation.
 */
const CLIENT_TITLE = 'LXTranslator';

/** Embeddings live on their own path. Also a constant, for the same reason. */
const EMBEDDING_ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';

module.exports = {
  name: 'openrouter',
  label: 'OpenRouter',
  defaultModel: 'openai/gpt-4o-mini',
  models: [
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-pro',
  ],
  embeddingModels: [
    'qwen/qwen3-embedding-8b',
    'openai/text-embedding-3-small',
    'openai/text-embedding-3-large',
    'qwen/qwen3-embedding-4b',
  ],
  defaultEmbeddingModel: 'qwen/qwen3-embedding-8b',
  /**
   * OpenRouter caches a marked prompt prefix, so a long system instruction and
   * a long tool catalogue are charged once rather than on every pass of the
   * agent loop. The mark is applied in {@link module.exports.chat}.
   */
  supportsCaching: true,
  requiresNetwork: true,

  /**
   * Translates a batch of strings.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Decrypted credential for this attempt.
   * @param {string} params.model Model identifier, vendor prefixed.
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
          'X-Title': CLIENT_TITLE,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt(sourceLang, targetLang) },
            { role: 'user', content: buildUserPrompt(texts) },
          ],
          // No response_format here, unlike the OpenAI adapter. The models
          // reachable through OpenRouter do not all support it, and a model
          // that rejects the field would fail for a reason unrelated to the
          // credential and burn the next key in the chain. The reply contract
          // is enforced by parseTranslationReply instead, which is the check
          // that actually protects the database.
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        kindFromTransportError(error),
        'The OpenRouter request could not be completed.',
        { provider: 'openrouter', cause: error },
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
        `OpenRouter responded with status ${response.status}.`,
        {
          status: response.status,
          provider: 'openrouter',
          cause: new Error(detail.slice(0, 300)),
        },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        'OpenRouter returned a body that was not valid JSON.',
        { provider: 'openrouter', cause: error },
      );
    }

    /*
     * OpenRouter reports an upstream failure two ways: as an HTTP status, and
     * as an error object inside a 200 body when the broker itself reached the
     * vendor but the vendor refused. The second form has to be mapped onto the
     * same categories, or a vendor side rate limit would look like a malformed
     * reply and the fallback chain would stop instead of trying the next key.
     */
    if (payload?.error) {
      const status = Number(payload.error.code);
      throw new ProviderError(
        Number.isInteger(status) ? kindFromStatus(status) : PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        'OpenRouter reported an upstream failure.',
        {
          status: Number.isInteger(status) ? status : undefined,
          provider: 'openrouter',
          cause: new Error(String(payload.error.message ?? '').slice(0, 300)),
        },
      );
    }

    const content = payload?.choices?.[0]?.message?.content;

    try {
      return parseTranslationReply(content, texts.length);
    } catch (error) {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
        `OpenRouter returned an unusable reply: ${error.message}`,
        { provider: 'openrouter', cause: error },
      );
    }
  },

  /**
   * Runs one assistant turn, with tools the model may call.
   *
   * The system instruction is sent as a content block carrying
   * `cache_control: ephemeral`. That is OpenRouter's prompt caching mark, and
   * it matters here more than anywhere else in the application: one question
   * may take several passes of the agent loop, and without the mark the same
   * instruction and the same tool catalogue are charged in full on every pass.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Decrypted credential for this attempt.
   * @param {string} params.model Model identifier, vendor prefixed.
   * @param {string} params.system System instruction.
   * @param {Array<object>} params.messages Conversation in the neutral shape.
   * @param {Array<object>} [params.tools] Declared tools.
   * @returns {Promise<{text: string|null, toolCalls: Array<object>, usage: object}>}
   * @throws {ProviderError} Categorised so the fallback chain can act on it.
   */
  async chat({ apiKey, model, system, messages, tools }) {
    return runChatCompletion({
      endpoint: ENDPOINT,
      label: 'OpenRouter',
      headers: { Authorization: `Bearer ${apiKey}`, 'X-Title': CLIENT_TITLE },
      body: { model },
      system,
      messages,
      tools,
      systemExtra: {
        content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      },
    });
  },

  /**
   * Produces one embedding vector.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Decrypted credential for this attempt.
   * @param {string} params.model Embedding model identifier, vendor prefixed.
   * @param {string} params.input Text to embed.
   * @returns {Promise<number[]>} The vector.
   * @throws {ProviderError} Categorised so the fallback chain can act on it.
   */
  async embed({ apiKey, model, input }) {
    return runEmbedding({
      endpoint: EMBEDDING_ENDPOINT,
      label: 'OpenRouter',
      headers: { Authorization: `Bearer ${apiKey}`, 'X-Title': CLIENT_TITLE },
      model,
      input,
    });
  },
};
