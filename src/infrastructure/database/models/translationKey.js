'use strict';

const { DataTypes } = require('sequelize');
const { TEXT_HASH_LENGTH, TEXT_HASH_PATTERN } = require('../../../core/textHash');

/**
 * Defines the `translation_keys` model.
 *
 * `original_text` always holds the English master text, because the pipeline
 * normalises every upload to `en_us.json` before fanning out to the target
 * languages. `text_hash` is a deterministic fingerprint of that master text,
 * fixed at exactly 36 characters, and it is what tells a consumer whether a
 * previously exported translation has gone stale.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The TranslationKey model.
 */
module.exports = (sequelize) => {
  const TranslationKey = sequelize.define(
    'TranslationKey',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      fileId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'file_id',
        references: { model: 'files', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
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
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
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
  TranslationKey.prototype.toPublicJson = function toPublicJson() {
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
