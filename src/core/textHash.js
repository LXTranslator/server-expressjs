'use strict';

const crypto = require('node:crypto');

/**
 * Length mandated by the schema for `translation_keys.text_hash`.
 * A canonical UUID string is exactly this long.
 */
const TEXT_HASH_LENGTH = 36;

/** Matches the canonical 8-4-4-4-12 hexadecimal layout. */
const TEXT_HASH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Derives a deterministic 36 character identifier from a source string.
 *
 * The value is a SHA-256 digest truncated to 128 bits and formatted as a UUID.
 * Determinism is the whole point: the same source text always yields the same
 * hash, so a changed hash in an exported file means the English source really
 * changed and the translation is stale.
 *
 * This is a change detection fingerprint, not a security primitive. It is never
 * used for authentication, signatures or password storage.
 *
 * @param {string} text Source text to fingerprint.
 * @returns {string} Exactly 36 characters in canonical UUID layout.
 */
function computeTextHash(text) {
  const digest = crypto.createHash('sha256').update(String(text), 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  // Stamp the version and variant nibbles so the value is a well formed UUID
  // rather than arbitrary hex wearing a UUID costume.
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // Version 8: custom, per RFC 9562.
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant: RFC 4122.

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Reports whether a value is a well formed text hash.
 *
 * @param {*} value Candidate value.
 * @returns {boolean}
 */
function isValidTextHash(value) {
  return typeof value === 'string' && value.length === TEXT_HASH_LENGTH && TEXT_HASH_PATTERN.test(value);
}

module.exports = { computeTextHash, isValidTextHash, TEXT_HASH_LENGTH, TEXT_HASH_PATTERN };
