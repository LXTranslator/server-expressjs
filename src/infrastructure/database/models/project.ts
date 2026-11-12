import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { AccountInstance } from './account';
import type { FileInstance } from './file';
import { reference, createdAt } from './columns';

/** Columns of the `Project` model, as the application reads them. */
export interface ProjectAttributes {
  id: number;
  namespaceAccountId: string;
  name: string;
  description: string | null;
  aiProvider: string;
  aiModel: string;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type ProjectCreationAttributes = Optional<ProjectAttributes, 'id' | 'description' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface ProjectPublicJson {
  id: ProjectAttributes['id'];
  namespace_account_id: ProjectAttributes['namespaceAccountId'];
  name: ProjectAttributes['name'];
  description: ProjectAttributes['description'];
  ai_provider: ProjectAttributes['aiProvider'];
  ai_model: ProjectAttributes['aiModel'];
  created_at: ProjectAttributes['createdAt'];
}

/** A loaded `Project` row. */
export interface ProjectInstance
  extends Model<ProjectAttributes, ProjectCreationAttributes>,
    ProjectAttributes {
  // Present only when the query asked for the association.
  namespace?: AccountInstance;
  files?: FileInstance[];
  readonly updatedAt: Date;
  toPublicJson(): ProjectPublicJson;
}

/** The `Project` model class. */
export type { ProjectPublicJson };
export type ProjectModel = ModelStatic<ProjectInstance>;

/**
 * Defines the `projects` model.
 *
 * A project is owned by a namespace account, which may be either a person or an
 * organization. Access checks therefore always resolve through the namespace
 * rather than through a direct owner column.
 *
 * Every project in the system lives in this one table, whoever owns it, so the
 * sequence behind `id` is shared and a project identifier is unique on its own.
 * A name only has to be unique within its owning namespace, which is what lets
 * two accounts each hold a project called `website` without collision.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {ProjectModel} The Project model.
 */
export default (sequelize: Sequelize): ProjectModel => {
  const Project = sequelize.define<ProjectInstance>(
    'Project',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      namespaceAccountId: reference('accounts', 'namespace_account_id'),
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: { len: [1, 100] },
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      aiProvider: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: 'ai_provider',
      },
      aiModel: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'ai_model',
      },
      createdAt: createdAt(),
    },
    {
      tableName: 'projects',
      updatedAt: 'updated_at',
      indexes: [
        // Unique per namespace and never globally, so the same project name is
        // free in every other account, user or organization alike.
        { unique: true, fields: ['namespace_account_id', 'name'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  (Project.prototype as ProjectInstance).toPublicJson = function toPublicJson(this: ProjectInstance): ProjectPublicJson {
    return {
      id: this.id,
      namespace_account_id: this.namespaceAccountId,
      name: this.name,
      description: this.description,
      ai_provider: this.aiProvider,
      ai_model: this.aiModel,
      created_at: this.createdAt,
    };
  };

  return Project;
};
