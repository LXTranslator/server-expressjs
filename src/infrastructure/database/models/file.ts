import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { ProjectInstance } from './project';
import type { TranslationKeyInstance } from './translationKey';
import { uuidKey, reference, createdAt } from './columns';

/** Lifecycle of an uploaded translation file. */
const FILE_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'FAILED'];

/** The master locale every other language is translated from. */
const MASTER_LANG_CODE = 'en_us';

/** Columns of the `File` model, as the application reads them. */
export interface FileAttributes {
  id: string;
  projectId: number;
  filename: string;
  sourceLangCode: string;
  targetLangCodes: string[];
  status: string;
  keyCount: number;
  errorMessage: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type FileCreationAttributes = Optional<FileAttributes, 'id' | 'sourceLangCode' | 'targetLangCodes' | 'status' | 'keyCount' | 'errorMessage' | 'processedAt' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface FilePublicJson {
  id: FileAttributes['id'];
  project_id: FileAttributes['projectId'];
  filename: FileAttributes['filename'];
  source_lang_code: FileAttributes['sourceLangCode'];
  target_lang_codes: FileAttributes['targetLangCodes'];
  status: FileAttributes['status'];
  key_count: FileAttributes['keyCount'];
  error_message: FileAttributes['errorMessage'];
  processed_at: FileAttributes['processedAt'];
  created_at: FileAttributes['createdAt'];
}

/** A loaded `File` row. */
export interface FileInstance
  extends Model<FileAttributes, FileCreationAttributes>,
    FileAttributes {
  // Present only when the query asked for the association.
  project?: ProjectInstance;
  translationKeys?: TranslationKeyInstance[];
  readonly updatedAt: Date;
  toPublicJson(): FilePublicJson;
}

/** The `File` model class. */
export type { FilePublicJson };
export type FileModel = ModelStatic<FileInstance>;

/**
 * Defines the `files` model.
 *
 * One project holds many files; one file holds many translation keys. The
 * status and progress columns let the client poll a long running worker job
 * without holding the upload request open.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {FileModel} The File model.
 */
export default (sequelize: Sequelize): FileModel => {
  const File = sequelize.define<FileInstance>(
    'File',
    {
      id: uuidKey(),
      projectId: reference('projects', 'project_id', { type: DataTypes.INTEGER }),
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
        get(this: FileInstance): string[] {
          // The column holds JSON text; the attribute is the parsed array.
          const raw = this.getDataValue('targetLangCodes') as unknown as string | null;
          try {
            const parsed = JSON.parse(raw ?? '[]');
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        },
        set(this: FileInstance, value: unknown): void {
          const encoded = JSON.stringify(Array.isArray(value) ? value : []);
          this.setDataValue('targetLangCodes', encoded as unknown as string[]);
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
      createdAt: createdAt(),
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
  (File.prototype as FileInstance).toPublicJson = function toPublicJson(this: FileInstance): FilePublicJson {
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

export { FILE_STATUSES, MASTER_LANG_CODE };
