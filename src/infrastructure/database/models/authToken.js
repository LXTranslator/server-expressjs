'use strict';

const { DataTypes } = require('sequelize');

/** Purposes a short lived token may be minted for. */
const TOKEN_PURPOSES = ['PASSWORD_RESET', 'EMAIL_CHANGE', 'SETTINGS_UPDATE'];

/**
 * Defines the `auth_tokens` model.
 *
 * A JWT alone cannot satisfy "invalid immediately upon first use", because a
 * signed token stays valid until it expires no matter how often it is
 * presented. This table is the server side ledger that makes single use real:
 * the JWT carries a `jti`, the row records whether that `jti` has been spent,
 * and consumption is a conditional update so two concurrent requests cannot
 * both succeed.
 *
 * Only a SHA-256 digest of the token is stored. Someone who reads this table
 * still cannot reconstruct a usable token.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AuthToken model.
 */
module.exports = (sequelize) => {
  const AuthToken = sequelize.define(
    'AuthToken',
    {
      /** Mirrors the `jti` claim of the issued JWT. */
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
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
      purpose: {
        type: DataTypes.ENUM(...TOKEN_PURPOSES),
        allowNull: false,
      },
      /** SHA-256 hex digest of the issued token string. */
      tokenHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'token_hash',
      },
      /** Purpose specific payload, for example a pending email address. */
      payload: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      /** Non null means the token has been spent and can never be reused. */
      consumedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'consumed_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'auth_tokens',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['account_id', 'purpose'] },
        { fields: ['expires_at'] },
      ],
    },
  );

  return AuthToken;
};

module.exports.TOKEN_PURPOSES = TOKEN_PURPOSES;
