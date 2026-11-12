import { buildSystemPrompt, buildUserPrompt } from '../prompt';
import { postJson, readTranslations } from '../vendorRequest';
import { runChatCompletion, runEmbedding } from './openaiChat';
import type { ChatMessage, ChatReply, ToolDefinition, ProviderAdapter } from '../types';

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

/** Embeddings live on their own path. Also a constant, for the same reason. */
const EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';

/** How this adapter is named on an error. */
const VENDOR = Object.freeze({ label: 'OpenAI', provider: 'openai' });

/**
 * Unwraps the object `response_format` requires, so the array contract can be
 * validated on what is inside it.
 *
 * @param {string} content Raw assistant content.
 * @returns {string} The translations array as text.
 */
function unwrapTranslations(content: string): string {
  const parsed = JSON.parse(content);
  return JSON.stringify(Array.isArray(parsed) ? parsed : parsed?.translations);
}

export default {
  name: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-4o-mini',
  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
  defaultEmbeddingModel: 'text-embedding-3-small',
  /**
   * OpenAI caches long prompt prefixes on its own side with no request field to
   * set, so there is nothing to send and nothing to configure.
   */
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
  async translateBatch({ apiKey, model, sourceLang, targetLang, texts }: { apiKey: string; model: string; sourceLang: string; targetLang: string; texts: string[]; }): Promise<string[]> {
    const payload = await postJson({
      ...VENDOR,
      endpoint: ENDPOINT,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(sourceLang, targetLang) },
          { role: 'user', content: buildUserPrompt(texts) },
        ],
        response_format: { type: 'json_object' },
      },
    });

    return readTranslations(payload?.choices?.[0]?.message?.content, texts.length, {
      ...VENDOR,
      unwrap: unwrapTranslations,
    });
  },

  /**
   * Runs one assistant turn, with tools the model may call.
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
  async chat({ apiKey, model, system, messages, tools }: { apiKey: string; model: string; system: string; messages: ChatMessage[]; tools?: ToolDefinition[]; }): Promise<ChatReply> {
    return runChatCompletion({
      endpoint: ENDPOINT,
      label: 'OpenAI',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model },
      system,
      messages,
      tools,
    });
  },

  /**
   * Produces one embedding vector.
   *
   * @param {object} params Call parameters.
   * @param {string} params.apiKey Decrypted credential for this attempt.
   * @param {string} params.model Embedding model identifier.
   * @param {string} params.input Text to embed.
   * @returns {Promise<number[]>} The vector.
   * @throws {ProviderError} Categorised so the fallback chain can act on it.
   */
  async embed({ apiKey, model, input }: { apiKey: string; model: string; input: string; }): Promise<number[]> {
    return runEmbedding({
      endpoint: EMBEDDING_ENDPOINT,
      label: 'OpenAI',
      headers: { Authorization: `Bearer ${apiKey}` },
      model,
      input,
    });
  },
} satisfies ProviderAdapter;
