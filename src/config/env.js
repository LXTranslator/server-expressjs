'use strict';

/**
 * Environment readers.
 *
 * Every value the application consumes is funnelled through these helpers so
 * that parsing, trimming and type coercion behave identically everywhere and so
 * that a missing value fails loudly instead of silently becoming `undefined`.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'disabled', '']);

/**
 * Reads a raw string value, returning the fallback when unset or blank.
 *
 * @param {string} name Environment variable name.
 * @param {string|undefined} fallback Value used when the variable is absent.
 * @returns {string|undefined}
 */
function readString(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Reads a boolean flag. Unrecognised values fall back rather than throwing so a
 * typo can never accidentally enable production mode.
 *
 * @param {string} name Environment variable name.
 * @param {boolean} fallback Value used when the variable is absent or unclear.
 * @returns {boolean}
 */
function readBoolean(name, fallback = false) {
  const raw = readString(name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return fallback;
}

/**
 * Reads an integer, clamping to an optional inclusive range.
 *
 * @param {string} name Environment variable name.
 * @param {number} fallback Value used when the variable is absent or invalid.
 * @param {{min?: number, max?: number}} [bounds] Optional clamp bounds.
 * @returns {number}
 */
function readInteger(name, fallback, bounds = {}) {
  const raw = readString(name);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (bounds.min !== undefined && value < bounds.min) value = bounds.min;
  if (bounds.max !== undefined && value > bounds.max) value = bounds.max;
  return value;
}

/**
 * Reads a comma separated list into an array of trimmed, non empty entries.
 *
 * @param {string} name Environment variable name.
 * @param {string[]} fallback Value used when the variable is absent.
 * @returns {string[]}
 */
function readList(name, fallback = []) {
  const raw = readString(name);
  if (raw === undefined) return [...fallback];
  const parts = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : [...fallback];
}

/**
 * Reads a value that must be present, used only for production critical
 * settings where a built in default would be a security defect.
 *
 * @param {string} name Environment variable name.
 * @returns {string}
 * @throws {Error} When the variable is missing.
 */
function requireString(name) {
  const value = readString(name);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        'It has no built in default because PROD is enabled. ' +
        'See wiki/environment.md for the full production checklist.',
    );
  }
  return value;
}

module.exports = { readString, readBoolean, readInteger, readList, requireString };
