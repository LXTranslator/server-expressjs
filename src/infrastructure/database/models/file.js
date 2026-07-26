'use strict';

const { DataTypes } = require('sequelize');

/** Lifecycle of an uploaded translation file. */
const FILE_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'FAILED'];

/** The master locale every other language is translated from. */
const MASTER_LANG_CODE = 'en_us';

/**
 * Defines the `files` model.
 *
 * One project holds many files; one file holds many translation keys. The
 * status and progress columns let the client poll a long running worker job
 * without holding the upload request open.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The File model.
 */
module.exports = (sequelize) => {
  const File = sequelize.define(
    'File',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      projectId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'project_id',
        references: { model: 'projects', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      /** Sanitised original name; never used to build a filesystem path. */
      filename: {
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      /** Locale of the uploaded document, which may not be the master locale. */
      sourceLangCode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: MASTER_LANG_CODE,
        field: 'source_lang_code',
      },
      /** Locales requested at upload time, stored as a JSON array of strings. */
      targetLangCodes: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '[]',
        field: 'target_lang_codes',
        get() {
          const raw = this.getDataValue('targetLangCodes');
          try {
            const parsed = JSON.parse(raw ?? '[]');
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        },
        set(value) {
          this.setDataValue('targetLangCodes', JSON.stringify(Array.isArray(value) ? value : []));
        },
      },
      status: {
        type: DataTypes.ENUM(...FILE_STATUSES),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      keyCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'key_count',
      },
      /** Client safe failure summary; stack traces stay in the logs. */
      errorMessage: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'error_message',
      },
      processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'processed_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'files',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['project_id'] },
        { unique: true, fields: ['project_id', 'filename'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  File.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      project_id: this.projectId,
      filename: this.filename,
      source_lang_code: this.sourceLangCode,
      target_lang_codes: this.targetLangCodes,
      status: this.status,
      key_count: this.keyCount,
      error_message: this.errorMessage,
      processed_at: this.processedAt,
      created_at: this.createdAt,
    };
  };

  return File;
};

module.exports.FILE_STATUSES = FILE_STATUSES;
module.exports.MASTER_LANG_CODE = MASTER_LANG_CODE;
