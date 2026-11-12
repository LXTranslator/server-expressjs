import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { TranslationKeyInstance } from './translationKey';
import { uuidKey, reference, createdAt } from './columns';
import { TEXT_HASH_LENGTH } from '../../../core/textHash';

/** Columns of the `Translation` model, as the application reads them. */
export interface TranslationAttributes {
  id: string;
  translationKeyId: string;
  langCode: string;
  translatedText: string;
  sourceHash: string | null;
  isManual: boolean;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type TranslationCreationAttributes = Optional<TranslationAttributes, 'id' | 'sourceHash' | 'isManual' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface TranslationPublicJson {
  id: TranslationAttributes['id'];
  translation_key_id: TranslationAttributes['translationKeyId'];
  lang_code: TranslationAttributes['langCode'];
  translated_text: TranslationAttributes['translatedText'];
  source_hash: TranslationAttributes['sourceHash'];
  is_manual: TranslationAttributes['isManual'];
  updated_at: Date;
}

/** A loaded `Translation` row. */
export interface TranslationInstance
  extends Model<TranslationAttributes, TranslationCreationAttributes>,
    TranslationAttributes {
  // Present only when the query asked for the association.
  translationKey?: TranslationKeyInstance;
  readonly updatedAt: Date;
  toPublicJson(): TranslationPublicJson;
}

/** The `Translation` model class. */
export type { TranslationPublicJson };
export type TranslationModel = ModelStatic<TranslationInstance>;

/**
 * Defines the `translations` model, one row per key per language.
 *
 * `source_hash` records the master text fingerprint that was current when the
 * translation was produced. Comparing it against the key's live `text_hash`
 * reveals stale rows without re-reading the original document.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {TranslationModel} The Translation model.
 */
export default (sequelize: Sequelize): TranslationModel => {
  const Translation = sequelize.define<TranslationInstance>(
    'Translation',
    {
      id: uuidKey(),
      translationKeyId: reference('translation_keys', 'translation_key_id'),
      langCode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        field: 'lang_code',
      },
      translatedText: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'translated_text',
      },
      /** Master text fingerprint at the time this translation was written. */
      sourceHash: {
        type: DataTypes.STRING(TEXT_HASH_LENGTH),
        allowNull: true,
        field: 'source_hash',
      },
      /** True once a human edits the text, so a rerun does not overwrite it. */
      isManual: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_manual',
      },
      createdAt: createdAt(),
    },
    {
      tableName: 'translations',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['translation_key_id', 'lang_code'] },
        { fields: ['lang_code'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  (Translation.prototype as TranslationInstance).toPublicJson = function toPublicJson(this: TranslationInstance): TranslationPublicJson {
    return {
      id: this.id,
      translation_key_id: this.translationKeyId,
      lang_code: this.langCode,
      translated_text: this.translatedText,
      source_hash: this.sourceHash,
      is_manual: this.isManual,
      updated_at: this.updatedAt,
    };
  };

  return Translation;
};
