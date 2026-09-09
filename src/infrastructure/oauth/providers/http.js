'use strict';

const config = require('../../../config');
const { ServiceUnavailableError } = require('../../../core/errors');

/**
 * The one place an OAuth provider is actually called over the network.
 *
 * Every endpoint reached from here is a constant declared in an adapter. None
 * of them is configurable, which is what keeps a tampered row or a crafted
 * payload from turning this into a request to somewhere else.
 */

/**
 * How long a provider gets to answer.
 *
 * A module constant rather than `config.ai.requestTimeoutMs`. That budget is
 * thirty seconds and tunable, which is right for a translation job and wrong
 * for a call sitting between somebody and their sign in.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Identifies this application to the provider.
 *
 * GitHub documents a `User-Agent` as required and answers without one by
 * refusing the request.
 */
const USER_AGENT = `${config.app.name.replace(/\s+/g, '')}/oauth`;

/**
 * Performs one JSON request against a provider, with a deadline.
 *
 * @param {string} url Constant endpoint from an adapter.
 * @param {{method?: string, headers?: object, body?: string}} options Request options.
 * @returns {Promise<{status: number, payload: object}>} Status and parsed body.
 * @throws {ServiceUnavailableError} When the provider is unreachable or too slow.
 */
async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(options.headers ?? {}),
      },
      body: options.body,
      signal: controller.signal,
    });
  } catch {
    // The provider's own message is not repeated to the caller: it is written
    // by somebody else and may say anything at all.
    throw new ServiceUnavailableError('The sign in provider could not be reached. Try again.');
  } finally {
    clearTimeout(timeout);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  return { status: response.status, payload };
}

module.exports = { requestJson, REQUEST_TIMEOUT_MS, USER_AGENT };
