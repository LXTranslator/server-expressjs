'use strict';

const config = require('../../config');
const { parseTranslationReply } = require('./prompt');
const {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  kindFromStatus,
  kindFromTransportError,
} = require('./providerError');

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
async function postJson({ endpoint, label, provider, headers, body, action = 'request' }) {
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
    return await response.json();
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
function assertNoUpstreamError(payload, { label, provider }) {
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
function readTranslations(text, expectedLength, { label, provider, unwrap }) {
  try {
    return parseTranslationReply(unwrap === undefined ? text : unwrap(text), expectedLength);
  } catch (error) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
      `${label} returned an unusable reply: ${error.message}`,
      { provider, cause: error },
    );
  }
}

module.exports = { postJson, assertNoUpstreamError, readTranslations };
