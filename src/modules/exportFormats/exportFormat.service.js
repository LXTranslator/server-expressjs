'use strict';

const logger = require('../../core/logger');
const { ExportFormat } = require('../../infrastructure/database/models');
const { BadRequestError, ConflictError, NotFoundError } = require('../../core/errors');
const {
  DEFAULT_FORMAT_ID,
  BUILT_IN_FORMATS,
  BUILT_IN_FORMAT_IDS,
  getBuiltInFormat,
  assertFieldName,
  toDescriptor,
  builtInToPublicJson,
} = require('./exportFormat.definitions');

/**
 * Export formats owned by a namespace.
 *
 * A format is written once for a namespace and offered by every project
 * underneath it, which is what lets a team define the shape their build tooling
 * expects and then pick it from a dropdown on any project they own.
 *
 * The built in formats are constants rather than rows, so they exist for every
 * namespace without seeding and cannot be edited or deleted. A namespace's own
 * formats are stored, and a stored row can never shadow a built in one: lookup
 * checks the constants first and creation refuses those identifiers outright.
 */

/**
 * Ceiling on stored formats per namespace.
 *
 * Each one is a row a caller can create at will, so it needs a bound like every
 * other unbounded write in the system. The number is far above any plausible
 * set of build targets.
 */
const MAX_FORMATS_PER_NAMESPACE = 50;

/**
 * Lists the formats a namespace can export in, built in ones first.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @returns {Promise<Array<object>>} Client safe formats.
 */
async function listFormats(namespaceAccountId) {
  const rows = await ExportFormat.findAll({
    where: { namespaceAccountId },
    order: [['created_at', 'ASC']],
  });

  return [
    ...BUILT_IN_FORMATS.map((format) => builtInToPublicJson(format)),
    ...rows.map((row) => row.toPublicJson()),
  ];
}

/**
 * Resolves the descriptor the export builder should use.
 *
 * Built in identifiers are answered from the constants, so `default` means the
 * same thing in every namespace whatever is stored.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @param {string} [formatId] Format identifier. Defaults to `default`.
 * @returns {Promise<object>} Format descriptor.
 * @throws {NotFoundError} When the namespace has no such format.
 */
async function resolveFormat(namespaceAccountId, formatId) {
  const wanted = formatId ?? DEFAULT_FORMAT_ID;

  const builtIn = getBuiltInFormat(wanted);
  if (builtIn !== null) return builtIn;

  const row = await ExportFormat.findOne({
    where: { namespaceAccountId, formatId: wanted },
  });
  if (row === null) {
    throw new NotFoundError(`This namespace has no export format called "${wanted}".`);
  }

  return toDescriptor(row);
}

/**
 * Validates the field names a payload asks for and normalises them.
 *
 * An object leaf needs a value field and may name a hash field; a string leaf
 * has no fields at all, so naming one is refused rather than silently ignored.
 *
 * @param {object} input Validated payload.
 * @param {object} [current] Descriptor being updated, when this is an update.
 * @returns {{leafShape: string, valueField: string|null, hashField: string|null}}
 * @throws {BadRequestError} When the combination is not usable.
 */
function resolveLeafFields(input, current = null) {
  const leafShape = input.leaf_shape ?? current?.leafShape ?? 'OBJECT';

  if (leafShape === 'STRING') {
    if (input.value_field !== undefined || input.hash_field !== undefined) {
      throw new BadRequestError(
        'A string leaf is the translated text itself, so it carries no named fields.',
      );
    }
    return { leafShape, valueField: null, hashField: null };
  }

  const valueField = assertFieldName(
    input.value_field ?? current?.valueField ?? 'value',
    'value field',
  );

  // Undefined leaves an existing choice alone; null is an explicit "no hash".
  const rawHashField =
    input.hash_field === undefined ? current?.hashField ?? 'hash' : input.hash_field;
  const hashField = rawHashField === null ? null : assertFieldName(rawHashField, 'hash field');

  if (hashField !== null && hashField === valueField) {
    throw new BadRequestError('The value field and the hash field must have different names.');
  }

  return { leafShape, valueField, hashField };
}

/**
 * Creates a format for a namespace.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @param {object} input Validated payload.
 * @returns {Promise<object>} Client safe format.
 * @throws {ConflictError} When the identifier is built in or already used here.
 * @throws {BadRequestError} When the namespace already holds the maximum.
 */
async function createFormat(namespaceAccountId, input) {
  if (BUILT_IN_FORMAT_IDS.includes(input.format_id)) {
    throw new ConflictError(
      `"${input.format_id}" is a built in format and cannot be redefined.`,
    );
  }

  const duplicate = await ExportFormat.findOne({
    where: { namespaceAccountId, formatId: input.format_id },
  });
  if (duplicate !== null) {
    throw new ConflictError('This namespace already has an export format with that identifier.');
  }

  const existingCount = await ExportFormat.count({ where: { namespaceAccountId } });
  if (existingCount >= MAX_FORMATS_PER_NAMESPACE) {
    throw new BadRequestError(
      `A namespace may hold ${MAX_FORMATS_PER_NAMESPACE} export formats. Remove one before adding another.`,
    );
  }

  const { leafShape, valueField, hashField } = resolveLeafFields(input);

  const format = await ExportFormat.create({
    namespaceAccountId,
    formatId: input.format_id,
    name: input.name,
    description: input.description ?? null,
    leafShape,
    valueField,
    hashField,
    nested: input.nested ?? true,
  });

  logger.info('Export format created.', { namespaceAccountId, formatId: format.formatId });
  return format.toPublicJson();
}

/**
 * Updates a format a namespace owns.
 *
 * The identifier itself is immutable, because a build script downloading with
 * `export_format=` would break the moment it changed.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @param {string} formatId Format identifier.
 * @param {object} input Validated payload.
 * @returns {Promise<object>} Client safe format.
 * @throws {ConflictError} When the format is built in.
 * @throws {NotFoundError} When the namespace has no such format.
 */
async function updateFormat(namespaceAccountId, formatId, input) {
  if (BUILT_IN_FORMAT_IDS.includes(formatId)) {
    throw new ConflictError('A built in export format cannot be changed.');
  }

  // The namespace predicate is what stops a caller from editing a format that
  // belongs to somebody else's namespace by naming its identifier.
  const format = await ExportFormat.findOne({ where: { namespaceAccountId, formatId } });
  if (format === null) {
    throw new NotFoundError('That export format does not exist in this namespace.');
  }

  const leaf = resolveLeafFields(input, format);

  await format.update({
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.nested === undefined ? {} : { nested: input.nested }),
    leafShape: leaf.leafShape,
    valueField: leaf.valueField,
    hashField: leaf.hashField,
  });

  logger.info('Export format updated.', { namespaceAccountId, formatId });
  return format.toPublicJson();
}

/**
 * Removes a format a namespace owns.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @param {string} formatId Format identifier.
 * @returns {Promise<void>}
 * @throws {ConflictError} When the format is built in.
 * @throws {NotFoundError} When the namespace has no such format.
 */
async function removeFormat(namespaceAccountId, formatId) {
  if (BUILT_IN_FORMAT_IDS.includes(formatId)) {
    throw new ConflictError('A built in export format cannot be removed.');
  }

  const deleted = await ExportFormat.destroy({ where: { namespaceAccountId, formatId } });
  if (deleted === 0) {
    throw new NotFoundError('That export format does not exist in this namespace.');
  }

  logger.info('Export format removed.', { namespaceAccountId, formatId });
}

module.exports = {
  listFormats,
  resolveFormat,
  createFormat,
  updateFormat,
  removeFormat,
  MAX_FORMATS_PER_NAMESPACE,
};
