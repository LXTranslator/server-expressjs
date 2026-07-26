'use strict';

const config = require('../../../config');
const {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  kindFromStatus,
  kindFromTransportError,
} = require('../providerError');

/**
 * The chat completions wire format, shared by OpenAI and OpenRouter.
 *
 * Both vendors speak the same request and reply shape for conversations and
 * tool calls, so the mapping lives here once. The endpoint is not part of it:
 * each adapter passes its own hardcoded constant, and no caller may supply one.
 * That is what keeps a shared helper from becoming the configurable base URL
 * the SSRF rules forbid.
 */

/**
 * Converts the neutral message shape into the vendor's.
 *
 * @param {Array<object>} messages Conversation in the neutral shape.
 * @returns {Array<object>} Vendor messages.
 */
function toVendorMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }

    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      };
    }

    return { role: message.role, content: message.content ?? '' };
  });
}

/**
 * Converts the neutral tool shape into the vendor's.
 *
 * @param {Array<object>} tools Declared tools.
 * @returns {Array<object>|undefined} Vendor tools, or undefined when there are none.
 */
function toVendorTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Reads the tool calls out of a vendor reply.
 *
 * Arguments arrive as a JSON string the model wrote, so parsing may fail. A
 * call whose arguments are unreadable is surfaced with empty arguments rather
 * than dropped: the dispatcher validates arguments anyway and will report a
 * usable message back to the model, which is more recoverable than silence.
 *
 * @param {object} message Vendor assistant message.
 * @returns {Array<object>} Tool calls in the neutral shape.
 */
function readToolCalls(message) {
  if (!Array.isArray(message?.tool_calls)) return [];

  return message.tool_calls
    .filter((call) => call?.function?.name)
    .map((call) => {
      let parsed = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}');
      } catch {
        parsed = {};
      }
      return {
        id: call.id ?? call.function.name,
        name: call.function.name,
        arguments: parsed !== null && typeof parsed === 'object' ? parsed : {},
      };
    });
}

/**
 * Runs one assistant turn against a chat completions endpoint.
 *
 * @param {object} params Call parameters.
 * @param {string} params.endpoint Hardcoded vendor endpoint.
 * @param {string} params.label Vendor name used in error messages.
 * @param {object} params.headers Request headers, including the credential.
 * @param {object} params.body Vendor specific body fields to merge in.
 * @param {string} params.system System instruction.
 * @param {Array<object>} params.messages Conversation in the neutral shape.
 * @param {Array<object>} [params.tools] Declared tools.
 * @param {object} [params.systemExtra] Extra fields merged into the system message.
 * @returns {Promise<{text: string|null, toolCalls: Array<object>, usage: object}>}
 * @throws {ProviderError} Categorised so the fallback chain can act on it.
 */
async function runChatCompletion({
  endpoint,
  label,
  headers,
  body,
  system,
  messages,
  tools,
  systemExtra,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        ...body,
        messages: [
          // Instructions stay in their own message, never concatenated with the
          // untrusted content of the conversation.
          { role: 'system', content: system, ...(systemExtra ?? {}) },
          ...toVendorMessages(messages),
        ],
        tools: toVendorTools(tools),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ProviderError(
      kindFromTransportError(error),
      `The ${label} request could not be completed.`,
      { provider: label, cause: error },
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
      `${label} responded with status ${response.status}.`,
      { status: response.status, provider: label, cause: new Error(detail.slice(0, 300)) },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned a body that was not valid JSON.`,
      { provider: label, cause: error },
    );
  }

  if (payload?.error) {
    const status = Number(payload.error.code);
    throw new ProviderError(
      Number.isInteger(status) ? kindFromStatus(status) : PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} reported an upstream failure.`,
      {
        status: Number.isInteger(status) ? status : undefined,
        provider: label,
        cause: new Error(String(payload.error.message ?? '').slice(0, 300)),
      },
    );
  }

  const message = payload?.choices?.[0]?.message;
  if (message === undefined || message === null) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned no message.`,
      { provider: label },
    );
  }

  return {
    text: typeof message.content === 'string' && message.content.length > 0 ? message.content : null,
    toolCalls: readToolCalls(message),
    usage: { totalTokens: Number(payload?.usage?.total_tokens) || 0 },
  };
}

/**
 * Requests one embedding vector from an embeddings endpoint.
 *
 * @param {object} params Call parameters.
 * @param {string} params.endpoint Hardcoded vendor endpoint.
 * @param {string} params.label Vendor name used in error messages.
 * @param {object} params.headers Request headers, including the credential.
 * @param {string} params.model Embedding model identifier.
 * @param {string} params.input Text to embed.
 * @returns {Promise<number[]>} The vector.
 * @throws {ProviderError} Categorised so the fallback chain can act on it.
 */
async function runEmbedding({ endpoint, label, headers, model, input }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model, input }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ProviderError(
      kindFromTransportError(error),
      `The ${label} embedding request could not be completed.`,
      { provider: label, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(
      kindFromStatus(response.status),
      `${label} responded with status ${response.status}.`,
      { status: response.status, provider: label, cause: new Error(detail.slice(0, 300)) },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned a body that was not valid JSON.`,
      { provider: label, cause: error },
    );
  }

  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned no usable embedding.`,
      { provider: label },
    );
  }

  return vector;
}

module.exports = { runChatCompletion, runEmbedding, toVendorMessages, toVendorTools, readToolCalls };
