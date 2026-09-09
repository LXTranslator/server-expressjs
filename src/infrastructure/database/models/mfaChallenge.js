'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `mfa_challenges` model.
 *
 * A sign in that has proved a password but not yet proved a second factor. The
 * row is the whole of that intermediate state: there is no cookie and no server
 * side browser session, so what the caller holds is a random string whose
 * digest is stored here.
 *
 * The credential this row backs is deliberately opaque rather than a signed
 * token. `authenticate` resolves a credential by shape, and a random string is
 * neither prefixed like an API token nor verifiable as a JWT, so it can never
 * be mistaken for a session however it is presented.
 *
 * `attempts` caps guessing against one challenge. It sits on top of the
 * account wide lockout rather than replacing it, because the account counter is
 * what stops somebody who already holds the password from simply starting a
 * fresh challenge for every guess.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The MfaChallenge model.
 */
module.exports = (sequelize) => {
  const MfaChallenge = sequelize.define(
    'MfaChallenge',
    {
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
      /** SHA-256 hex digest of the challenge string. The string itself is never stored. */
      tokenHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'token_hash',
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      /**
       * Set on success only.
       *
       * A mistyped code has to stay retryable, or every slip costs a fresh
       * password entry. `attempts` is what bounds that, not consumption.
       */
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
      tableName: 'mfa_challenges',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['token_hash'] },
        { fields: ['account_id', 'consumed_at'] },
        { fields: ['expires_at'] },
      ],
    },
  );

  return MfaChallenge;
};
