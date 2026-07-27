'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `api_usage_logs` model.
 *
 * One row per authenticated request: who made it, with which credential, what
 * they asked for and what came back. The question it exists to answer is "what
 * has been done on this account", which nothing else could answer once a
 * credential could act without a person present.
 *
 * That matters most for machine credentials. A session belongs to somebody who
 * remembers using it; a token sitting in a build server does not, and "this
 * token has not been used in four months" or "this token deleted forty files on
 * Tuesday" are the only ways to notice either that it is dead weight or that
 * somebody else has it.
 *
 * What is deliberately absent is as much of the design as what is present.
 * No request body, no response body, no headers, no query string, no address.
 * A body carries the very things this system is careful about elsewhere,
 * translation text and provider credentials among them, and a log that
 * accumulated them would quietly become the most sensitive table in the
 * schema. The path and the status say what happened; the payload does not need
 * to be kept to know that.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The ApiUsageLog model.
 */
module.exports = (sequelize) => {
  const ApiUsageLog = sequelize.define(
    'ApiUsageLog',
    {
      /**
       * Autoincrementing rather than a UUID. This table is read in time order
       * far more often than it is addressed by identifier, and it is the
       * highest volume table in the schema, so the narrower key is worth it.
       */
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      accountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      /**
       * Which credential was used.
       *
       * Nullable, and deliberately not a foreign key: a revoked credential is
       * eventually purged, and the record of what it did must outlive it. An
       * audit trail that disappeared when somebody deleted the token would be
       * exactly the wrong way round.
       */
      sessionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'session_id',
      },
      /** `SESSION` or `API`, so machine traffic can be told from a person's. */
      credentialKind: {
        type: DataTypes.STRING(10),
        allowNull: true,
        field: 'credential_kind',
      },
      method: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      /**
       * The path, without its query string.
       *
       * Real identifiers are kept rather than collapsed to `:projectId`,
       * because "which project" is most of what makes an entry meaningful. The
       * query string is dropped: it carries search terms and other things
       * somebody typed, which this table has no business accumulating.
       */
      path: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      statusCode: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'status_code',
      },
      /** How long the request took, in milliseconds. */
      durationMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'duration_ms',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'api_usage_logs',
      // Nothing ever updates a row here, so the column would only ever repeat
      // created_at on the largest table in the schema.
      timestamps: false,
      indexes: [
        // The list query: this account's recent activity.
        { fields: ['account_id', 'created_at'] },
        // "What has this token been doing", which is the question a machine
        // credential exists to raise.
        { fields: ['session_id'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  ApiUsageLog.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      session_id: this.sessionId,
      credential_kind: this.credentialKind,
      method: this.method,
      path: this.path,
      status_code: this.statusCode,
      duration_ms: this.durationMs,
      created_at: this.createdAt,
    };
  };

  return ApiUsageLog;
};
