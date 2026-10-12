'use strict';

const { buildSystemPrompt, buildUserPrompt } = require('../prompt');
const { ProviderError, PROVIDER_ERROR_KINDS } = require('../providerError');
const { postJson, readTranslations } = require('../vendorRequest');

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

/** How this adapter is named on an error. */
const VENDOR = Object.freeze({ label: 'Anthropic', provider: 'anthropic' });

/**
 * Posts one Messages API request.
 *
 * `max_tokens` is required on every request, so it is added here rather than
 * left for each call to remember.
 *
 * @param {string} apiKey Decrypted credential for this attempt.
 * @param {object} body Request fields besides `max_tokens`.
 * @returns {Promise<object>} Parsed reply body.
 * @throws {ProviderError} Categorised so the fallback chain can act on it.
 */
function postMessages(apiKey, body) {
  return postJson({
    ...VENDOR,
    endpoint: ENDPOINT,
    headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
    body: { ...body, max_tokens: MAX_OUTPUT_TOKENS },
  });
}

/**
 * Joins the text blocks of a reply. Only text blocks carry the answer.
 *
 * @param {Array<object>} blocks Reply content blocks.
 * @returns {string} The reply text, empty when there is none.
 */
function textOf(blocks) {
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Converts the neutral message shape into the Messages API shape.
 *
 * The API has no `tool` role. A tool result is a `tool_result` block inside a
 * user turn, paired to the call by its identifier, and an assistant turn that
 * called a tool carries a `tool_use` block. Consecutive tool results are merged
 * into one user turn, because the API rejects two user turns in a row.
 *
 * @param {Array<object>} messages Conversation in the neutral shape.
 * @returns {Array<object>} Messages API turns.
 */
function toAnthropicMessages(messages) {
  const turns = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      };

      const previous = turns[turns.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(block);
        continue;
      }

      turns.push({ role: 'user', content: [block] });
      continue;
    }

    if (message.role === 'assistant') {
      const content = [];
      if (typeof message.content === 'string' && message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      if (content.length > 0) turns.push({ role: 'assistant', content });
      continue;
    }

    turns.push({ role: 'user', content: message.content ?? '' });
  }

  return turns;
}

module.exports = {
  name: 'anthropic',
  label: 'Anthropic Claude',
  defaultModel: 'claude-opus-5',
  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  /**
   * Deliberately empty. Anthropic does not serve an embeddings endpoint of its
   * own and points at external partners for it, so there is no model here that
   * this adapter could honestly offer. An account choosing Anthropic for chat
   * either leaves the embedding model unset, which the assistant handles, or
   * configures a second credential on a platform that does serve one.
   */
  embeddingModels: [],
  defaultEmbeddingModel: null,
  /** Anthropic caches a prefix marked with `cache_control`. */
  supportsCaching: true,
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
    const payload = await postMessages(apiKey, {
      model,
      // Instructions stay in the system field, never concatenated with the
      // untrusted content in the user turn.
      system: buildSystemPrompt(sourceLang, targetLang),
      messages: [{ role: 'user', content: buildUserPrompt(texts) }],
    });

    // A safety decline arrives as a normal 200 with stop_reason "refusal", so
    // it has to be checked before the content array is read.
    if (payload?.stop_reason === 'refusal') {
      throw new ProviderError(
        PROVIDER_ERROR_KINDS.REQUEST,
        'Anthropic declined to translate this batch.',
        { provider: 'anthropic' },
      );
    }

    const text = Array.isArray(payload?.content) ? textOf(payload.content) : '';
    return readTranslations(text, texts.length, VENDOR);
  },

  /**
   * Runs one assistant turn, with tools the model may call.
   *
   * The Messages API differs from the chat completions shape in three ways that
   * matter here: the system instruction is its own top level field rather than
   * a message, a tool result is a content block inside a user turn rather than
   * a role of its own, and `max_tokens` is required. The system field carries
   * `cache_control` so a long instruction and tool catalogue are charged once
   * rather than on every pass of the agent loop.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Decrypted credential for this attempt.
   * @param {string} params.model Model identifier.
   * @param {string} params.system System instruction.
   * @param {Array<object>} params.messages Conversation in the neutral shape.
   * @param {Array<object>} [params.tools] Declared tools.
   * @returns {Promise<{text: string|null, toolCalls: Array<object>, usage: object}>}
   * @throws {ProviderError} Categorised so the fallback chain can act on it.
   */
  async chat({ apiKey, model, system, messages, tools }) {
    const payload = await postMessages(apiKey, {
      model,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(messages),
      ...(Array.isArray(tools) && tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    });

    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    const text = textOf(blocks);

    const toolCalls = blocks
      .filter((block) => block?.type === 'tool_use' && block.name)
      .map((block) => ({
        id: block.id ?? block.name,
        name: block.name,
        arguments: block.input !== null && typeof block.input === 'object' ? block.input : {},
      }));

    const usage = payload?.usage ?? {};

    return {
      text: text.length > 0 ? text : null,
      toolCalls,
      usage: {
        totalTokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
      },
    };
  },
};
