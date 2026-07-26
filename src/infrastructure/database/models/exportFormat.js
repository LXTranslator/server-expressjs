'use strict';

const { DataTypes } = require('sequelize');

/** Shape of one exported leaf: an object carrying fields, or the bare string. */
const LEAF_SHAPES = ['OBJECT', 'STRING'];

/**
 * Field names refused inside a leaf, because writing one onto a plain object
 * reaches `Object.prototype` and poisons every object in the process.
 */
const FORBIDDEN_FIELD_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Field names are emitted into a JSON document, so the character set is narrow. */
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** Stable identifier a client sends to select a format. */
const FORMAT_ID_PATTERN = /^[a-z0-9_]{2,50}$/;

/**
 * Defines the `export_formats` model.
 *
 * A format describes how a locale document is written out, and it belongs to a
 * namespace account rather than to a project. That is deliberate: a team writes
 * the shape their build tooling expects once, and every project under the same
 * namespace can then be downloaded in it. Binding it to a project would mean
 * redefining the same shape for each one.
 *
 * A format is data, never code. It names the leaf shape and the field names to
 * emit, and the export builder interprets those. Nothing stored here is
 * evaluated, so a stored row cannot become a template injection.
 *
 * The two formats the application ships with, `default` and `key_value`, are
 * constants rather than rows. Keeping them out of the table means they exist
 * for every namespace without seeding, and that nobody can edit or delete the
 * shape a published consumer already depends on.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The ExportFormat model.
 */
module.exports = (sequelize) => {
  const ExportFormat = sequelize.define(
    'ExportFormat',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      namespaceAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'namespace_account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      /** Identifier a client sends to select this format, unique per namespace. */
      formatId: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: 'format_id',
        validate: { is: FORMAT_ID_PATTERN },
      },
      name: {
        type: DataTypes.STRING(80),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      leafShape: {
        type: DataTypes.ENUM(...LEAF_SHAPES),
        allowNull: false,
        defaultValue: 'OBJECT',
        field: 'leaf_shape',
      },
      /** Field carrying the translated string, used only by an OBJECT leaf. */
      valueField: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'value_field',
      },
      /** Field carrying the master fingerprint. Null omits the hash entirely. */
      hashField: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'hash_field',
      },
      /** True expands `a.b.c` into a tree; false emits the dotted path as a key. */
      nested: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'export_formats',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['namespace_account_id', 'format_id'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  ExportFormat.prototype.toPublicJson = function toPublicJson() {
    return {
      format_id: this.formatId,
      name: this.name,
      description: this.description,
      leaf_shape: this.leafShape,
      value_field: this.valueField,
      hash_field: this.hashField,
      nested: this.nested,
      built_in: false,
      created_at: this.createdAt,
    };
  };

  return ExportFormat;
};

module.exports.LEAF_SHAPES = LEAF_SHAPES;
module.exports.FORBIDDEN_FIELD_NAMES = FORBIDDEN_FIELD_NAMES;
module.exports.FIELD_NAME_PATTERN = FIELD_NAME_PATTERN;
module.exports.FORMAT_ID_PATTERN = FORMAT_ID_PATTERN;
