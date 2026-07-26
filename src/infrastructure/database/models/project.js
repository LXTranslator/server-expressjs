'use strict';

const { DataTypes } = require('sequelize');

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
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The Project model.
 */
module.exports = (sequelize) => {
  const Project = sequelize.define(
    'Project',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
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
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
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
  Project.prototype.toPublicJson = function toPublicJson() {
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
