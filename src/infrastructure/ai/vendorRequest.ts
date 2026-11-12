import config from '../../config';
import { parseTranslationReply } from './prompt';
import {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  kindFromStatus,
  kindFromTransportError,
} from './providerError';

/**
 * A parsed vendor reply.
 *
 * Every field is optional because nothing about a reply's shape is trusted:
 * each adapter checks what it reads before using it.
 */
interface VendorPayload {
  error?: { code?: unknown; message?: unknown } | null;
  /** Chat completions: OpenAI and OpenRouter. */
  choices?: Array<{ message?: VendorMessage | null }>;
  /** Embeddings: OpenAI and OpenRouter. */
  data?: Array<{ embedding?: unknown }>;
  /** Messages API: Anthropic. */
  content?: VendorContentBlock[];
  stop_reason?: string;
  usage?: {
    total_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

/** An assistant message in the chat completions shape. */
interface VendorMessage {
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  } | null>;
}

/** A content block in the Messages API shape. */
interface VendorContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}


/**
 * The one place an AI vendor is called over the network.
 *
 * Every adapter passes its own hardcoded endpoint, and no caller may supply
 * one. That is what keeps a shared helper from becoming the configurable base
 * URL the SSRF rules forbid.
 *
 * Each failure is categorised so the fallback chain can act on it, and a
 * vendor's own words never reach the message: they go on `cause`, for the
 * operator log only, since a vendor body can echo request content back.
 */

/**
 * Posts one JSON request within the configured deadline and parses the reply.
 *
 * @param {object} params Call parameters.
 * @param {string} params.endpoint Hardcoded vendor endpoint.
 * @param {string} params.label Vendor name used in error messages.
 * @param {string} params.provider Provider recorded on an error.
 * @param {object} params.headers Request headers, including the credential.
 * @param {object} params.body Request body, serialised here.
 * @param {string} [params.action] What the call is, as a failed transport names it.
 * @returns {Promise<object>} Parsed reply body.
 * @throws {ProviderError} On a transport failure, a non 2xx status or a body that is not JSON.
 */
async function postJson({ endpoint, label, provider, headers, body, action = 'request' }: { endpoint: string; label: string; provider: string; headers: Record<string, string>; body: object; action?: string; }): Promise<VendorPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      // The credential is only ever placed in a header, never in a URL or a
      // log line.
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ProviderError(
      kindFromTransportError(error),
      `The ${label} ${action} could not be completed.`,
      { provider, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(
      kindFromStatus(response.status),
      `${label} responded with status ${response.status}.`,
      { status: response.status, provider, cause: new Error(detail.slice(0, 300)) },
    );
  }

  try {
    return (await response.json()) as VendorPayload;
  } catch (error) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned a body that was not valid JSON.`,
      { provider, cause: error },
    );
  }
}

/**
 * Raises the failure a broker reports inside a 200 body.
 *
 * OpenRouter answers 200 when it reached the vendor and the vendor refused. The
 * error has to be mapped onto the same categories as a status, or a vendor side
 * rate limit would look like a malformed reply and the fallback chain would
 * stop instead of trying the next key.
 *
 * @param {object} payload Parsed reply body.
 * @param {{label: string, provider: string}} vendor Names used on the error.
 * @returns {void}
 * @throws {ProviderError} When the body carries an error object.
 */
function assertNoUpstreamError(payload: VendorPayload | null | undefined, { label, provider }: { label: string; provider: string; }): void {
  if (!payload?.error) return;

  const status = Number(payload.error.code);
  throw new ProviderError(
    Number.isInteger(status) ? kindFromStatus(status) : PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
    `${label} reported an upstream failure.`,
    {
      status: Number.isInteger(status) ? status : undefined,
      provider,
      cause: new Error(String(payload.error.message ?? '').slice(0, 300)),
    },
  );
}

/**
 * Validates a translation reply against the batch it answers.
 *
 * @param {string} text Raw reply text.
 * @param {number} expectedLength Number of strings sent.
 * @param {object} vendor Names used on the error.
 * @param {string} vendor.label Vendor name used in the message.
 * @param {string} vendor.provider Provider recorded on the error.
 * @param {(text: string) => string} [vendor.unwrap] Turns a wrapped reply into the array text.
 * @returns {string[]} Translations in the input order.
 * @throws {ProviderError} When the reply breaks the array contract.
 */
function readTranslations(text: unknown, expectedLength: number, { label, provider, unwrap }: { label: string; provider: string; unwrap?: (text: string) => string; }): string[] {
  try {
    // An unwrap that is handed something other than text throws, which lands
    // in the same refusal below.
    return parseTranslationReply(unwrap === undefined ? text : unwrap(text as string), expectedLength);
  } catch (error) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned an unusable reply: ${(error as Error).message}`,
      { provider, cause: error },
    );
  }
}

export { postJson, assertNoUpstreamError, readTranslations };
export type { VendorPayload, VendorMessage, VendorContentBlock };
