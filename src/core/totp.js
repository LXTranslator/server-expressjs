'use strict';

const crypto = require('node:crypto');

/**
 * Time based one time passwords, RFC 6238 over RFC 4226.
 *
 * Written here rather than installed, for the reason `zip.js` gives: the hard
 * part already ships in Node's `crypto`, and the rest is a counter, an HMAC and
 * a modulo. `supply-chain.md` asks for a standard library equivalent where one
 * exists, and a dependency on the login path is a trust decision that buys
 * nothing here.
 *
 * The parameters below are constants rather than settings on purpose. They are
 * what Google Authenticator, 1Password and Aegis implement, so changing any of
 * them does not make the application stricter, it makes it incompatible with
 * every authenticator a person already has. A configurable verification window
 * would be worse still: it is a security parameter with a tuning knob, which is
 * exactly what the fixed ten minute token lifetime avoids elsewhere.
 */

/** RFC 4648 base32. No padding on output; Google Authenticator dislikes `=`. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Digits in a generated code. */
const TOTP_DIGITS = 6;

/** Seconds each code is valid for, before drift. */
const TOTP_PERIOD_SECONDS = 30;

/** HMAC used to derive a code. SHA-1 is what the authenticator apps implement. */
const TOTP_ALGORITHM = 'sha1';

/**
 * Steps either side of the current one that are still accepted.
 *
 * One step covers the ordinary case: a phone clock a little out, or a person
 * who started typing just before the code rolled over. It also means a code
 * stays valid for up to ninety seconds, which is why the caller must record the
 * counter it accepted and refuse anything at or below it.
 */
const TOTP_WINDOW = 1;

/** Bytes of entropy in a generated secret. RFC 4226 section 4 asks for 160 bits. */
const SECRET_BYTES = 20;

/**
 * Encodes bytes as unpadded base32.
 *
 * @param {Buffer} buffer Bytes to encode.
 * @returns {string} Base32 text, uppercase, no padding.
 */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes base32 text back to bytes.
 *
 * Spaces, hyphens, padding and lower case are all tolerated, because a person
 * reading a secret off a screen types it with spaces in it.
 *
 * @param {string} text Base32 text.
 * @returns {Buffer} Decoded bytes.
 * @throws {TypeError} When the text is not valid base32.
 */
function base32Decode(text) {
  if (typeof text !== 'string') {
    throw new TypeError('A base32 secret must be a string.');
  }

  const normalized = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (normalized.length === 0) {
    throw new TypeError('A base32 secret must not be empty.');
  }

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new TypeError('A base32 secret contains a character outside the alphabet.');
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generates a fresh secret.
 *
 * @returns {{secret: Buffer, base32: string}} The raw bytes and their base32 form.
 */
function generateSecret() {
  const secret = crypto.randomBytes(SECRET_BYTES);
  return { secret, base32: base32Encode(secret) };
}

/**
 * Compares two codes without leaking where they differ.
 *
 * `safeEquals` in `infrastructure/crypto/secretBox.js` does the same thing, but
 * `core` sits below `infrastructure` and may not call upward, so the two byte
 * lines are repeated rather than the layer boundary broken.
 *
 * @param {string} left First value.
 * @param {string} right Second value.
 * @returns {boolean} True when the values are identical.
 */
function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');

  // timingSafeEqual throws on a length mismatch, and the length of a code is
  // not a secret, so it is checked first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Converts a moment to the counter that covers it.
 *
 * @param {number} [at] Milliseconds since the epoch.
 * @returns {number} The time step.
 */
function counterAt(at = Date.now()) {
  return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Derives the code for one counter.
 *
 * @param {Buffer} secret Shared secret.
 * @param {number} counter Time step.
 * @returns {string} A zero padded code.
 */
function deriveCode(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac(TOTP_ALGORITHM, secret).update(message).digest();

  // RFC 4226 section 5.3 dynamic truncation. The low nibble of the last byte
  // chooses where to read, so the same secret does not always use the same
  // four bytes of the digest.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Reduces whatever the person typed to bare digits.
 *
 * @param {string} code Submitted code.
 * @returns {string|null} The normalized code, or null when it is not one.
 */
function normalizeCode(code) {
  if (typeof code !== 'string') return null;

  const trimmed = code.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(trimmed)) return null;

  return trimmed;
}

/**
 * Verifies a submitted code against the accepted window.
 *
 * The matched counter comes back with the answer because the caller needs it:
 * a code stays valid across the whole window, so refusing to reuse one means
 * recording which step was spent. This function has no memory of its own.
 *
 * @param {Buffer} secret Shared secret.
 * @param {string} code Submitted code.
 * @param {{window?: number, at?: number}} [options] Drift and the current time.
 * @returns {{valid: boolean, counter: number|null}} The outcome and the step matched.
 */
function verifyCode(secret, code, options = {}) {
  const normalized = normalizeCode(code);

  // Shape is checked before any HMAC, so a malformed code costs nothing.
  if (normalized === null) return { valid: false, counter: null };

  const window = options.window ?? TOTP_WINDOW;
  const current = counterAt(options.at);

  for (let step = current - window; step <= current + window; step += 1) {
    if (step < 0) continue;
    if (constantTimeEquals(deriveCode(secret, step), normalized)) {
      return { valid: true, counter: step };
    }
  }

  return { valid: false, counter: null };
}

/**
 * Builds the `otpauth://` URI an authenticator app reads from a QR code.
 *
 * The two halves of the label are escaped individually and the colon between
 * them is left literal, because that separator is what the app splits on. The
 * URI carries the raw secret, so it is shown once and never returned again.
 *
 * @param {{issuer: string, accountName: string, base32Secret: string}} params Label parts.
 * @returns {string} The URI.
 */
function buildOtpauthUri({ issuer, accountName, base32Secret }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: TOTP_ALGORITHM.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });

  return `otpauth://totp/${label}?${query.toString()}`;
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  counterAt,
  deriveCode,
  normalizeCode,
  verifyCode,
  buildOtpauthUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_ALGORITHM,
  TOTP_WINDOW,
};
