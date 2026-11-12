import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { AccountInstance } from './account';
import { uuidKey, reference, createdAt } from './columns';

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

/** Columns of the `ExportFormat` model, as the application reads them. */
export interface ExportFormatAttributes {
  id: string;
  namespaceAccountId: string;
  formatId: string;
  name: string;
  description: string | null;
  leafShape: string;
  valueField: string | null;
  hashField: string | null;
  nested: boolean;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type ExportFormatCreationAttributes = Optional<ExportFormatAttributes, 'id' | 'description' | 'leafShape' | 'valueField' | 'hashField' | 'nested' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface ExportFormatPublicJson {
  format_id: ExportFormatAttributes['formatId'];
  name: ExportFormatAttributes['name'];
  description: ExportFormatAttributes['description'];
  leaf_shape: ExportFormatAttributes['leafShape'];
  value_field: ExportFormatAttributes['valueField'];
  hash_field: ExportFormatAttributes['hashField'];
  nested: ExportFormatAttributes['nested'];
  built_in: false;
  created_at: ExportFormatAttributes['createdAt'];
}

/** A loaded `ExportFormat` row. */
export interface ExportFormatInstance
  extends Model<ExportFormatAttributes, ExportFormatCreationAttributes>,
    ExportFormatAttributes {
  // Present only when the query asked for the association.
  namespace?: AccountInstance;
  readonly updatedAt: Date;
  toPublicJson(): ExportFormatPublicJson;
}

/** The `ExportFormat` model class. */
export type { ExportFormatPublicJson };
export type ExportFormatModel = ModelStatic<ExportFormatInstance>;

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
 * The three formats the application ships with, `default`, `key_value` and
 * `flat_key_value`, are constants rather than rows. Keeping them out of the
 * table means they exist for every namespace without seeding, and that nobody
 * can edit or delete the shape a published consumer already depends on.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {ExportFormatModel} The ExportFormat model.
 */
export default (sequelize: Sequelize): ExportFormatModel => {
  const ExportFormat = sequelize.define<ExportFormatInstance>(
    'ExportFormat',
    {
      id: uuidKey(),
      namespaceAccountId: reference('accounts', 'namespace_account_id'),
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
      createdAt: createdAt(),
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
  (ExportFormat.prototype as ExportFormatInstance).toPublicJson = function toPublicJson(this: ExportFormatInstance): ExportFormatPublicJson {
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

export { LEAF_SHAPES, FORBIDDEN_FIELD_NAMES, FIELD_NAME_PATTERN, FORMAT_ID_PATTERN };
