'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `project_api_keys` model.
 *
 * `api_key` never holds a plaintext credential. The service layer encrypts the
 * value with AES-256-GCM before it is written, and `last_four` exists purely so
 * the interface can identify a key without decrypting anything.
 *
 * `priority_order` drives the fallback chain: the worker tries the lowest
 * number first and moves down the list when a key fails.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The ProjectApiKey model.
 */
module.exports = (sequelize) => {
  const ProjectApiKey = sequelize.define(
    'ProjectApiKey',
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
      /** AES-256-GCM envelope, never a readable credential. */
      apiKey: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'api_key',
      },
      label: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      /** Masked tail of the credential, safe to display. */
      lastFour: {
        type: DataTypes.STRING(4),
        allowNull: true,
        field: 'last_four',
      },
      priorityOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'priority_order',
        validate: { min: 1, max: 1000 },
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
      },
      lastUsedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_used_at',
      },
      lastErrorAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_error_at',
      },
      /** Client safe reason string from the most recent failure. */
      lastErrorReason: {
        type: DataTypes.STRING(200),
        allowNull: true,
        field: 'last_error_reason',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'project_api_keys',
      updatedAt: 'updated_at',
      /**
       * The encrypted column is excluded from every default query. Reading it
       * requires asking for it by name, which makes accidental exposure through
       * a generic `findAll` impossible.
       */
      defaultScope: { attributes: { exclude: ['api_key'] } },
      scopes: {
        withSecret: { attributes: { include: ['api_key'] } },
      },
      indexes: [{ fields: ['project_id', 'priority_order'] }],
    },
  );

  /**
   * @returns {object} Representation that never contains key material.
   */
  ProjectApiKey.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      project_id: this.projectId,
      label: this.label,
      masked_key: this.lastFour ? `****${this.lastFour}` : '****',
      priority_order: this.priorityOrder,
      is_active: this.isActive,
      last_used_at: this.lastUsedAt,
      last_error_at: this.lastErrorAt,
      last_error_reason: this.lastErrorReason,
      created_at: this.createdAt,
    };
  };

  return ProjectApiKey;
};
