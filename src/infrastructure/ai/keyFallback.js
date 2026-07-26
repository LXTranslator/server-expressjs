'use strict';

const config = require('../../config');
const { getProvider } = require('./providers');
const { ProviderError, PROVIDER_ERROR_KINDS } = require('./providerError');

/**
 * API key fallback executor.
 *
 * A caller may hold several credentials for the work it is about to do. These
 * functions walk them in priority order and move to the next one whenever an
 * attempt fails for a reason another credential could plausibly survive: a
 * revoked key, an exhausted quota, a throttled key, a vendor outage.
 *
 * Two rules keep the walk from doing something useless or harmful:
 *
 *   1. A `REQUEST` failure means the payload itself is wrong. Every remaining
 *      key would fail identically, so the chain stops immediately rather than
 *      burning the caller's other credentials on a defect of our own making.
 *   2. Transient categories get a bounded retry against the same key before the
 *      chain advances, so a single blip does not permanently demote the
 *      preferred credential.
 *
 * Nothing here logs or returns key material. Callers receive the masked
 * identifier of the credential that succeeded, never the credential.
 */

/**
 * Pauses between retries with exponential backoff.
 *
 * @param {number} attempt Zero based attempt index.
 * @returns {Promise<void>}
 */
function backoff(attempt) {
  const delay = Math.min(2000, 100 * 2 ** attempt);
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * Walks a credential chain until one attempt succeeds.
 *
 * The work itself is the caller's, passed in as `attempt`. Everything about
 * which credential to try next, how often, and when to stop lives here, so a
 * translation batch and an account level chat turn cannot drift into two
 * different fallback rules.
 *
 * @param {object} params Execution parameters.
 * @param {Array<object>} params.keys Candidate credentials, already decrypted
 *   and already sorted by priority.
 * @param {(key: object) => Promise<*>} params.attempt Work to run against one
 *   credential. Rejecting with a {@link ProviderError} drives the chain.
 * @param {string} params.emptyMessage Message for the failure raised when the
 *   chain holds no credential at all.
 * @param {string} [params.provider] Provider name recorded on raised errors.
 * @param {(event: object) => void} [params.onAttempt] Observer for telemetry.
 * @returns {Promise<{value: *, keyId: string|null, key: object, attempts: object[]}>}
 * @throws {ProviderError} When no credential succeeds.
 */
async function runWithKeyFallback({ keys, attempt, emptyMessage, provider, onAttempt }) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ProviderError(PROVIDER_ERROR_KINDS.AUTH, emptyMessage, { provider });
  }

  const attempts = [];
  let lastError = null;

  for (const key of keys) {
    for (let retry = 0; retry < config.ai.maxAttemptsPerKey; retry += 1) {
      try {
        const value = await attempt(key);

        attempts.push({ keyId: key.id, outcome: 'SUCCESS', retry });
        if (onAttempt) onAttempt({ keyId: key.id, outcome: 'SUCCESS' });

        return { value, keyId: key.id, key, attempts };
      } catch (error) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
                'The provider adapter raised an unexpected error.',
                { provider: key.provider ?? provider, cause: error },
              );

        lastError = providerError;
        attempts.push({
          keyId: key.id,
          outcome: 'FAILED',
          kind: providerError.kind,
          retry,
        });
        if (onAttempt) {
          onAttempt({
            keyId: key.id,
            outcome: 'FAILED',
            kind: providerError.kind,
            reason: providerError.message,
          });
        }

        // Our own request is malformed. Trying the remaining keys would fail
        // the same way and would waste real quota, so stop here.
        if (!providerError.shouldTryNextKey) {
          providerError.attempts = attempts;
          throw providerError;
        }

        // Transient category: give this key one more chance before demoting it.
        const hasRetryBudget = retry < config.ai.maxAttemptsPerKey - 1;
        if (providerError.isRetryableWithSameKey && hasRetryBudget) {
          await backoff(retry);
          continue;
        }

        break; // Advance to the next credential.
      }
    }
  }

  const exhausted = new ProviderError(
    lastError?.kind ?? PROVIDER_ERROR_KINDS.AUTH,
    `Every configured API key failed. Last failure: ${lastError?.message ?? 'unknown'}`,
    { provider },
  );
  exhausted.attempts = attempts;
  throw exhausted;
}

/**
 * Runs one translation batch against the first credential that works.
 *
 * @param {object} params Execution parameters.
 * @param {string} params.providerName Provider identifier.
 * @param {string} params.model Model identifier.
 * @param {Array<{id: string, apiKey: string, label: string|null, lastFour: string|null}>} params.keys
 *   Candidate credentials, already decrypted and already sorted by priority.
 * @param {string} params.sourceLang Source locale code.
 * @param {string} params.targetLang Target locale code.
 * @param {string[]} params.texts Strings to translate.
 * @param {(event: object) => void} [params.onAttempt] Observer for telemetry.
 * @returns {Promise<{translations: string[], keyId: string|null, attempts: object[]}>}
 * @throws {ProviderError} When no credential succeeds.
 */
async function translateWithKeyFallback({
  providerName,
  model,
  keys,
  sourceLang,
  targetLang,
  texts,
  onAttempt,
}) {
  const provider = getProvider(providerName);
  if (provider === null) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.REQUEST,
      `The provider "${providerName}" is not supported.`,
    );
  }

  const { value, keyId, attempts } = await runWithKeyFallback({
    keys,
    provider: providerName,
    emptyMessage: 'The project has no active API key for its selected provider.',
    onAttempt,
    attempt: (key) =>
      provider.translateBatch({
        apiKey: key.apiKey,
        model,
        sourceLang,
        targetLang,
        texts,
      }),
  });

  return { translations: value, keyId, attempts };
}

module.exports = { translateWithKeyFallback, runWithKeyFallback };
