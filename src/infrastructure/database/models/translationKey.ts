import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { FileInstance } from './file';
import type { TranslationInstance, TranslationPublicJson } from './translation';
import { uuidKey, reference, createdAt } from './columns';
import { TEXT_HASH_LENGTH, TEXT_HASH_PATTERN } from '../../../core/textHash';

/** Columns of the `TranslationKey` model, as the application reads them. */
export interface TranslationKeyAttributes {
  id: string;
  fileId: string;
  keyName: string;
  originalText: string;
  textHash: string;
  sourceText: string | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type TranslationKeyCreationAttributes = Optional<TranslationKeyAttributes, 'id' | 'sourceText' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface TranslationKeyPublicJson {
  id: TranslationKeyAttributes['id'];
  file_id: TranslationKeyAttributes['fileId'];
  key_name: TranslationKeyAttributes['keyName'];
  original_text: TranslationKeyAttributes['originalText'];
  source_text: TranslationKeyAttributes['sourceText'];
  text_hash: TranslationKeyAttributes['textHash'];
  translations?: TranslationPublicJson[];
}

/** A loaded `TranslationKey` row. */
export interface TranslationKeyInstance
  extends Model<TranslationKeyAttributes, TranslationKeyCreationAttributes>,
    TranslationKeyAttributes {
  // Present only when the query asked for the association.
  file?: FileInstance;
  translations?: TranslationInstance[];
  readonly updatedAt: Date;
  toPublicJson(): TranslationKeyPublicJson;
}

/** The `TranslationKey` model class. */
export type { TranslationKeyPublicJson };
export type TranslationKeyModel = ModelStatic<TranslationKeyInstance>;

/**
 * Defines the `translation_keys` model.
 *
 * `original_text` always holds the English master text, because the pipeline
 * normalises every upload to `en_us.json` before fanning out to the target
 * languages. `text_hash` is a deterministic fingerprint of that master text,
 * fixed at exactly 36 characters, and it is what tells a consumer whether a
 * previously exported translation has gone stale.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {TranslationKeyModel} The TranslationKey model.
 */
export default (sequelize: Sequelize): TranslationKeyModel => {
  const TranslationKey = sequelize.define<TranslationKeyInstance>(
    'TranslationKey',
    {
      id: uuidKey(),
      fileId: reference('files', 'file_id'),
      keyName: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'key_name',
      },
      originalText: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'original_text',
      },
      textHash: {
        type: DataTypes.STRING(TEXT_HASH_LENGTH),
        allowNull: false,
        field: 'text_hash',
        validate: {
          is: TEXT_HASH_PATTERN,
          len: [TEXT_HASH_LENGTH, TEXT_HASH_LENGTH],
        },
      },
      /** Text exactly as uploaded, kept when the source was not English. */
      sourceText: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'source_text',
      },
      createdAt: createdAt(),
    },
    {
      tableName: 'translation_keys',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['file_id'] },
        { unique: true, fields: ['file_id', 'key_name'] },
        { fields: ['text_hash'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  (TranslationKey.prototype as TranslationKeyInstance).toPublicJson = function toPublicJson(this: TranslationKeyInstance): TranslationKeyPublicJson {
    return {
      id: this.id,
      file_id: this.fileId,
      key_name: this.keyName,
      original_text: this.originalText,
      source_text: this.sourceText,
      text_hash: this.textHash,
      translations: Array.isArray(this.translations)
        ? this.translations.map((entry) => entry.toPublicJson())
        : undefined,
    };
  };

  return TranslationKey;
};
