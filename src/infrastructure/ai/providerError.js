'use strict';

/**
 * Failure categories a translation provider can produce.
 *
 * The category, not the vendor specific message, is what drives the fallback
 * decision. Mapping every provider onto this small set keeps the fallback logic
 * identical no matter which vendor a project selected.
 */
const PROVIDER_ERROR_KINDS = Object.freeze({
  /** Key rejected: missing, revoked, malformed or lacking permission. */
  AUTH: 'AUTH',
  /** Key throttled for now. */
  RATE_LIMIT: 'RATE_LIMIT',
  /** Key has no credit or has hit a hard usage ceiling. */
  QUOTA: 'QUOTA',
  /** Vendor side fault. */
  SERVER: 'SERVER',
  /** Connection could not be established or was cut. */
  NETWORK: 'NETWORK',
  /** Vendor did not answer within the configured budget. */
  TIMEOUT: 'TIMEOUT',
  /** Vendor answered, but not in the contract shape we require. */
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  /** Our request was malformed. Another key would fail identically. */
  REQUEST: 'REQUEST',
});

/**
 * Categories worth retrying with the same key before moving on, because they
 * describe transient conditions rather than a bad credential.
 */
const RETRY_SAME_KEY = new Set([
  PROVIDER_ERROR_KINDS.SERVER,
  PROVIDER_ERROR_KINDS.NETWORK,
  PROVIDER_ERROR_KINDS.TIMEOUT,
]);

/**
 * The only category that must not consume the rest of the fallback chain: if we
 * built a bad request, every remaining key would fail the same way, and burning
 * them would just hide the real defect.
 */
const FATAL_FOR_CHAIN = new Set([PROVIDER_ERROR_KINDS.REQUEST]);

/**
 * Error raised by every provider adapter.
 */
class ProviderError extends Error {
  /**
   * @param {string} kind One of {@link PROVIDER_ERROR_KINDS}.
   * @param {string} message Operator facing description, free of key material.
   * @param {{status?: number, provider?: string, cause?: Error}} [meta] Extra context.
   */
  constructor(kind, message, meta = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = meta.status ?? null;
    this.provider = meta.provider ?? null;
    if (meta.cause) this.cause = meta.cause;
  }

  /** @returns {boolean} True when retrying the same credential is sensible. */
  get isRetryableWithSameKey() {
    return RETRY_SAME_KEY.has(this.kind);
  }

  /** @returns {boolean} True when the next credential should be attempted. */
  get shouldTryNextKey() {
    return !FATAL_FOR_CHAIN.has(this.kind);
  }
}

/**
 * Maps an HTTP status onto a failure category.
 *
 * @param {number} status HTTP status code from the vendor.
 * @returns {string} A {@link PROVIDER_ERROR_KINDS} value.
 */
function kindFromStatus(status) {
  if (status === 401 || status === 403) return PROVIDER_ERROR_KINDS.AUTH;
  if (status === 429) return PROVIDER_ERROR_KINDS.RATE_LIMIT;
  if (status === 402) return PROVIDER_ERROR_KINDS.QUOTA;
  if (status >= 500) return PROVIDER_ERROR_KINDS.SERVER;
  if (status >= 400) return PROVIDER_ERROR_KINDS.REQUEST;
  return PROVIDER_ERROR_KINDS.SERVER;
}

/**
 * Maps a thrown transport error onto a failure category.
 *
 * @param {Error} error Error raised by fetch or the runtime.
 * @returns {string} A {@link PROVIDER_ERROR_KINDS} value.
 */
function kindFromTransportError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return PROVIDER_ERROR_KINDS.TIMEOUT;
  }
  return PROVIDER_ERROR_KINDS.NETWORK;
}

module.exports = {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  kindFromStatus,
  kindFromTransportError,
};
