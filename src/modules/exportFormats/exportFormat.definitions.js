'use strict';

const {
  FORBIDDEN_FIELD_NAMES,
  FIELD_NAME_PATTERN,
} = require('../../infrastructure/database/models/exportFormat');
const { BadRequestError } = require('../../core/errors');

/**
 * Export format descriptors.
 *
 * A descriptor is the plain object the export builder reads. It says what a
 * leaf looks like and what its fields are called, and nothing else. There is no
 * template string and no expression, so a format a user creates can change the
 * shape of a document but can never introduce behaviour.
 *
 * The three formats below ship with the application and belong to every
 * namespace. They are constants rather than rows so that no namespace has to be
 * seeded to have them, and so that nobody can edit or delete a shape a
 * published consumer already depends on.
 */

/** Identifier of the format used when a caller names none. */
const DEFAULT_FORMAT_ID = 'default';

/**
 * The original export shape: every leaf carries the translated string next to
 * the fingerprint of the English master it was produced from. The fingerprint
 * is what makes a stale translation detectable downstream.
 */
const DEFAULT_FORMAT = Object.freeze({
  formatId: DEFAULT_FORMAT_ID,
  name: 'Value and hash',
  description:
    'Every leaf carries the translated string and the fingerprint of the English master it came from, so a consumer can tell when the source changed.',
  leafShape: 'OBJECT',
  valueField: 'value',
  hashField: 'hash',
  nested: true,
  builtIn: true,
});

/**
 * Plain key and value pairs, the shape a localization library reads directly.
 * There is no fingerprint, so staleness cannot be detected from the file alone;
 * that is the trade for a document that drops straight into an application.
 */
const KEY_VALUE_FORMAT = Object.freeze({
  formatId: 'key_value',
  name: 'Key and value',
  description:
    'Plain JSON key and value pairs, ready to use as it is. Carries no fingerprint, so staleness cannot be read from the file.',
  leafShape: 'STRING',
  valueField: null,
  hashField: null,
  nested: true,
  builtIn: true,
});

/**
 * The same bare strings, with every dotted path left as one key.
 *
 * `key_value` rebuilds the nesting the upload had, so `greeting.hello` comes
 * back as an object inside an object. Plenty of tooling wants the opposite: a
 * single flat map it can look a full key path up in, which is what a gettext
 * style catalogue and several mobile toolchains expect. That is one field
 * different from `key_value`, and it ships rather than being left for each
 * namespace to recreate by hand, because it is the shape people ask for by
 * name.
 */
const FLAT_KEY_VALUE_FORMAT = Object.freeze({
  formatId: 'flat_key_value',
  name: 'Flat key and value',
  description:
    'Plain JSON key and value pairs with the dotted path kept as a single key, so nothing is nested. Carries no fingerprint, so staleness cannot be read from the file.',
  leafShape: 'STRING',
  valueField: null,
  hashField: null,
  nested: false,
  builtIn: true,
});

/** Formats every namespace has, in the order a dropdown should offer them. */
const BUILT_IN_FORMATS = Object.freeze([DEFAULT_FORMAT, KEY_VALUE_FORMAT, FLAT_KEY_VALUE_FORMAT]);

/** Identifiers a namespace may not reuse for a format of its own. */
const BUILT_IN_FORMAT_IDS = Object.freeze(BUILT_IN_FORMATS.map((format) => format.formatId));

/**
 * Resolves a built in format by identifier.
 *
 * @param {string} formatId Format identifier.
 * @returns {object|null} The descriptor, or null when the name is not built in.
 */
function getBuiltInFormat(formatId) {
  return BUILT_IN_FORMATS.find((format) => format.formatId === formatId) ?? null;
}

/**
 * Validates a leaf field name.
 *
 * The name is written as a key onto an exported object, so a name such as
 * `__proto__` would reach `Object.prototype`. The pattern alone already refuses
 * it, and the explicit list is the second line.
 *
 * @param {string} name Candidate field name.
 * @param {string} label Field being validated, used in the message.
 * @returns {string} The accepted name.
 * @throws {BadRequestError} When the name is unsafe or malformed.
 */
function assertFieldName(name, label) {
  const value = String(name);

  if (FORBIDDEN_FIELD_NAMES.includes(value) || !FIELD_NAME_PATTERN.test(value)) {
    throw new BadRequestError(
      `"${value}" is not a usable ${label}. Use lowercase letters, digits and underscores, starting with a letter.`,
    );
  }

  return value;
}

/**
 * Turns a stored row into the descriptor the export builder reads.
 *
 * @param {object} row ExportFormat model instance.
 * @returns {object} Format descriptor.
 */
function toDescriptor(row) {
  return {
    formatId: row.formatId,
    name: row.name,
    description: row.description,
    leafShape: row.leafShape,
    valueField: row.valueField,
    hashField: row.hashField,
    nested: row.nested,
    builtIn: false,
  };
}

/**
 * Projects a built in descriptor down to the client representation, matching
 * the shape a stored row serialises to.
 *
 * @param {object} format Format descriptor.
 * @returns {object} Client safe representation.
 */
function builtInToPublicJson(format) {
  return {
    format_id: format.formatId,
    name: format.name,
    description: format.description,
    leaf_shape: format.leafShape,
    value_field: format.valueField,
    hash_field: format.hashField,
    nested: format.nested,
    built_in: true,
    created_at: null,
  };
}

module.exports = {
  DEFAULT_FORMAT_ID,
  DEFAULT_FORMAT,
  KEY_VALUE_FORMAT,
  FLAT_KEY_VALUE_FORMAT,
  BUILT_IN_FORMATS,
  BUILT_IN_FORMAT_IDS,
  getBuiltInFormat,
  assertFieldName,
  toDescriptor,
  builtInToPublicJson,
};
