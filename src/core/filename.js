'use strict';

const path = require('node:path');
const { BadRequestError } = require('./errors');

/**
 * Filename sanitisation for uploads.
 *
 * The name that arrives on a multipart part is entirely attacker controlled. It
 * is used for two different things, and each needs its own defence:
 *
 *   - It is stored and displayed, so it must not carry control characters or
 *     path separators.
 *   - It must never be joined onto a filesystem path, because
 *     `../../etc/passwd` or an absolute path would escape the storage
 *     directory. Files are written under a generated UUID instead, and
 *     {@link resolveWithinDirectory} enforces containment as a second layer.
 */

/** Characters permitted in a stored filename, after the extension is split off. */
const SAFE_STEM_PATTERN = /^[A-Za-z0-9._ -]+$/;

/** Windows device names, reserved regardless of extension. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Reduces an uploaded filename to a safe, storable form.
 *
 * @param {string} rawName Name supplied by the client.
 * @param {{allowedExtensions: string[], maxLength: number}} rules Validation rules.
 * @returns {string} Sanitised filename.
 * @throws {BadRequestError} When the name cannot be made safe.
 */
function sanitizeFilename(rawName, rules) {
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw new BadRequestError('The uploaded file has no name.');
  }

  // A null byte can truncate the name inside a C level filesystem call, so a
  // name containing one is rejected outright rather than cleaned.
  if (rawName.includes('\0')) {
    throw new BadRequestError('The filename contains an illegal character.');
  }

  // Strip any directory component. Both separators are handled because the
  // client's platform is unknown, and basename alone would keep `..\evil` on a
  // POSIX server.
  const flattened = rawName.replace(/\\/g, '/');
  const base = path.posix.basename(flattened).trim();

  if (base.length === 0 || base === '.' || base === '..') {
    throw new BadRequestError('The filename is not valid.');
  }

  // Defence in depth: after flattening there should be no traversal left.
  if (base.includes('/') || base.includes('..')) {
    throw new BadRequestError('The filename must not contain a path.');
  }

  if (base.length > rules.maxLength) {
    throw new BadRequestError(`The filename must be ${rules.maxLength} characters or fewer.`);
  }

  const extension = path.posix.extname(base).toLowerCase();
  if (!rules.allowedExtensions.includes(extension)) {
    throw new BadRequestError(
      `Only ${rules.allowedExtensions.join(', ')} files may be uploaded.`,
    );
  }

  const stem = base.slice(0, base.length - extension.length);
  if (stem.length === 0) {
    throw new BadRequestError('The filename must have a name before its extension.');
  }

  // A leading dot would create a hidden file; control characters would corrupt
  // logs and interface output.
  if (stem.startsWith('.') || /[\u0000-\u001f\u007f]/.test(stem)) {
    throw new BadRequestError('The filename contains an illegal character.');
  }

  if (!SAFE_STEM_PATTERN.test(stem)) {
    throw new BadRequestError(
      'The filename may contain only letters, digits, spaces, dots, underscores and hyphens.',
    );
  }

  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    throw new BadRequestError('That filename is reserved by the operating system.');
  }

  return `${stem}${extension}`;
}

/**
 * Resolves a path and proves it stays inside a directory.
 *
 * Used on every filesystem write and read, so even a defect elsewhere in the
 * chain cannot reach outside the storage root.
 *
 * @param {string} directory Absolute directory that must contain the result.
 * @param {string} candidate Relative path segment.
 * @returns {string} Absolute, contained path.
 * @throws {BadRequestError} When the result would escape the directory.
 */
function resolveWithinDirectory(directory, candidate) {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, candidate);

  // The separator suffix stops `/data/storage_evil` from passing a naive
  // prefix test against `/data/storage`.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new BadRequestError('The requested path is outside the storage directory.');
  }

  return resolved;
}

module.exports = { sanitizeFilename, resolveWithinDirectory, SAFE_STEM_PATTERN, RESERVED_NAMES };
