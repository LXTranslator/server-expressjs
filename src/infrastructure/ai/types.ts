/**
 * The provider neutral shapes every AI adapter speaks.
 *
 * The chat service and the tools work in these shapes only. Each adapter turns
 * them into its vendor's wire format and back, so nothing above this layer
 * knows which vendor answered.
 */

/** A JSON Schema fragment, as declared to a model. */
type JsonSchema = Record<string, unknown>;

/** A tool call the model asked for. */
interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A tool as it is declared to a model. */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** One message of a conversation. */
interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  /** On an assistant turn: the calls it made. */
  toolCalls?: ToolCall[];
  /** On a tool result: the call it answers. */
  toolCallId?: string;
  /** On a tool result: the tool that produced it. */
  name?: string;
}

/** Tokens one call spent. */
interface ChatUsage {
  totalTokens: number;
}

/** One assistant turn. */
interface ChatReply {
  text: string | null;
  toolCalls: ToolCall[];
  usage: ChatUsage;
}

/** Arguments to a batch translation. */
interface TranslateBatchParams {
  apiKey: string;
  model: string;
  sourceLang: string;
  targetLang: string;
  texts: string[];
}

/** Arguments to one assistant turn. */
interface ChatParams {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

/** Arguments to one embedding. */
interface EmbedParams {
  apiKey: string;
  model: string;
  input: string;
}

/** A decrypted credential, ready for one provider call. */
interface ProviderKey {
  id: string | null;
  apiKey: string;
  provider?: string;
  label?: string | null;
  lastFour?: string | null;
}

/** One try against one credential, as the fallback chain records it. */
interface KeyAttempt {
  keyId: string | null;
  outcome: 'SUCCESS' | 'FAILED';
  kind?: string;
  retry: number;
}

/** What the fallback chain reports to an observer after each try. */
interface KeyAttemptEvent {
  keyId: string | null;
  outcome: 'SUCCESS' | 'FAILED';
  kind?: string;
  reason?: string;
}

/** What every provider adapter offers. */
interface ProviderAdapter {
  name: string;
  label: string;
  defaultModel: string;
  models: string[];
  embeddingModels: string[];
  defaultEmbeddingModel: string | null;
  supportsCaching: boolean;
  requiresNetwork: boolean;
  translateBatch(params: TranslateBatchParams): Promise<string[]>;
  chat(params: ChatParams): Promise<ChatReply>;
  embed?(params: EmbedParams): Promise<number[]>;
}

export type {
  JsonSchema,
  ToolCall,
  ToolDefinition,
  ChatMessage,
  ChatUsage,
  ChatReply,
  TranslateBatchParams,
  ChatParams,
  EmbedParams,
  ProviderAdapter,
  ProviderKey,
  KeyAttempt,
  KeyAttemptEvent,
};
