'use strict';

const config = require('../config');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * Field names whose values are replaced before anything reaches the log sink.
 * Matching is case insensitive and substring based so `userPassword`,
 * `api_key` and `Authorization` are all caught.
 */
const REDACTED_FIELDS = [
  'password',
  'passwordhash',
  'confirmpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'secret',
  'passphrase',
  'credential',
  'otp',
];

const REDACTION_PLACEHOLDER = '[redacted]';
const MAX_REDACTION_DEPTH = 8;

/**
 * Decides whether a key looks sensitive.
 *
 * @param {string} key Object key being inspected.
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z]/g, '');
  return REDACTED_FIELDS.some((field) => normalized.includes(field.replace(/[^a-z]/g, '')));
}

/**
 * Recursively copies a value, replacing sensitive fields with a placeholder.
 *
 * Logging is one of the easiest ways to leak credentials, so redaction happens
 * here rather than at each call site where it could be forgotten.
 *
 * @param {*} value Value to sanitise.
 * @param {number} [depth] Current recursion depth.
 * @returns {*} Sanitised copy safe to serialise.
 */
function redact(value, depth = 0) {
  if (depth > MAX_REDACTION_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code };
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTION_PLACEHOLDER : redact(entry, depth + 1);
  }
  return output;
}

const activeLevel = LEVELS[config.app.logLevel] ?? LEVELS.info;

/**
 * Emits one structured JSON line.
 *
 * @param {string} level Log level name.
 * @param {string} message Human readable message.
 * @param {object} [context] Structured context, redacted before output.
 */
function write(level, message, context = {}) {
  if (LEVELS[level] > activeLevel) return;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redact(context),
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

module.exports = {
  error: (message, context) => write('error', message, context),
  warn: (message, context) => write('warn', message, context),
  info: (message, context) => write('info', message, context),
  debug: (message, context) => write('debug', message, context),
  redact,
};
