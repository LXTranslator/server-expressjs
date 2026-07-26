'use strict';

const config = require('../../config');
const { getProvider } = require('./providers');
const { ProviderError, PROVIDER_ERROR_KINDS } = require('./providerError');

/**
 * API key fallback executor.
 *
 * A project may register several credentials for its chosen provider. This
 * function walks them in `priority_order` and moves to the next one whenever an
 * attempt fails for a reason that another credential could plausibly survive:
 * a revoked key, an exhausted quota, a throttled key, a vendor outage.
 *
 * Two rules keep the walk from doing something useless or harmful:
 *
 *   1. A `REQUEST` failure means the payload itself is wrong. Every remaining
 *      key would fail identically, so the chain stops immediately rather than
 *      burning the project's other credentials on a defect of our own making.
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

  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ProviderError(
      PROVIDER_ERROR_KINDS.AUTH,
      'The project has no active API key for its selected provider.',
      { provider: providerName },
    );
  }

  const attempts = [];
  let lastError = null;

  for (const key of keys) {
    for (let retry = 0; retry < config.ai.maxAttemptsPerKey; retry += 1) {
      try {
        const translations = await provider.translateBatch({
          apiKey: key.apiKey,
          model,
          sourceLang,
          targetLang,
          texts,
        });

        attempts.push({ keyId: key.id, outcome: 'SUCCESS', retry });
        if (onAttempt) onAttempt({ keyId: key.id, outcome: 'SUCCESS' });

        return { translations, keyId: key.id, attempts };
      } catch (error) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                PROVIDER_ERROR_KINDS.INVALID_RESPONSE,
                'The provider adapter raised an unexpected error.',
                { provider: providerName, cause: error },
              );

        lastError = providerError;
        attempts.push({
          keyId: key.id,
          outcome: 'FAILED',
          kind: providerError.kind,
          retry,
        });
        if (onAttempt) {
          onAttempt({ keyId: key.id, outcome: 'FAILED', kind: providerError.kind, reason: providerError.message });
        }

        // Our own request is malformed. Trying the remaining keys would fail
        // the same way and would waste real quota, so stop here.
        if (!providerError.shouldTryNextKey) {
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

  throw new ProviderError(
    lastError?.kind ?? PROVIDER_ERROR_KINDS.AUTH,
    `Every configured API key failed. Last failure: ${lastError?.message ?? 'unknown'}`,
    { provider: providerName },
  );
}

module.exports = { translateWithKeyFallback };
