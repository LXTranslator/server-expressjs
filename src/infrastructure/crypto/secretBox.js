'use strict';

const crypto = require('node:crypto');
const config = require('../../config');

/**
 * Authenticated encryption for values that must survive a database compromise,
 * currently the per project AI provider API keys.
 *
 * Algorithm: AES-256-GCM.
 *   - 256 bit key derived from the configured passphrase with scrypt.
 *   - 96 bit random IV per message, never reused.
 *   - 128 bit authentication tag, so tampering fails closed on decrypt.
 *
 * Wire format: `v1:<iv>:<tag>:<ciphertext>`, each part base64url encoded. The
 * version prefix exists so the algorithm can be rotated later without guessing
 * how historical rows were written.
 */

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Fixed salt for key derivation.
 *
 * A per record salt would be stronger, but it would also make the key
 * undiscoverable without storing it alongside the ciphertext. The passphrase is
 * the actual secret here and it lives outside the database, so a static salt is
 * an accepted, documented trade off.
 */
const KEY_SALT = Buffer.from('lxtranslator.secretbox.v1', 'utf8');

let cachedKey = null;

/**
 * Derives and caches the symmetric key.
 *
 * scrypt is deliberately slow, so it runs once per process rather than once per
 * encrypt call.
 *
 * @returns {Buffer} 32 byte key.
 */
function getKey() {
  if (cachedKey === null) {
    cachedKey = crypto.scryptSync(config.security.encryptionPassphrase, KEY_SALT, KEY_BYTES);
  }
  return cachedKey;
}

/**
 * Encrypts a plaintext secret.
 *
 * @param {string} plaintext Value to protect.
 * @returns {string} Encoded ciphertext envelope.
 * @throws {TypeError} When the input is not a non empty string.
 */
function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('encryptSecret expects a non empty string.');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypts an envelope produced by {@link encryptSecret}.
 *
 * @param {string} envelope Stored ciphertext.
 * @returns {string} Original plaintext.
 * @throws {Error} When the envelope is malformed or fails authentication.
 */
function decryptSecret(envelope) {
  if (typeof envelope !== 'string') {
    throw new TypeError('decryptSecret expects a string envelope.');
  }

  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('The stored secret is not in a recognised format.');
  }

  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('The stored secret has invalid cryptographic parameters.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Produces a display safe fingerprint of a key, for example `sk_live_...9f2a`.
 *
 * The client never receives a decrypted key; it receives this instead so a user
 * can still tell which credential a row refers to.
 *
 * @param {string} plaintext Original secret.
 * @returns {string} Masked representation.
 */
function maskSecret(plaintext) {
  const value = String(plaintext);
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Compares two strings without leaking their relationship through timing.
 *
 * @param {string} left First value.
 * @param {string} right Second value.
 * @returns {boolean} True when the values are identical.
 */
function safeEquals(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { encryptSecret, decryptSecret, maskSecret, safeEquals };
