'use strict';

const { DataTypes } = require('sequelize');
const { TEXT_HASH_LENGTH } = require('../../../core/textHash');

/**
 * Defines the `translations` model, one row per key per language.
 *
 * `source_hash` records the master text fingerprint that was current when the
 * translation was produced. Comparing it against the key's live `text_hash`
 * reveals stale rows without re-reading the original document.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The Translation model.
 */
module.exports = (sequelize) => {
  const Translation = sequelize.define(
    'Translation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      translationKeyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'translation_key_id',
        references: { model: 'translation_keys', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
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
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
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
  Translation.prototype.toPublicJson = function toPublicJson() {
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
