'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `account_recovery_codes` model.
 *
 * The way back in when the authenticator is gone. Without these, a lost phone
 * means an account nobody can reach without editing the database by hand.
 *
 * A code is stored as a SHA-256 digest, not a bcrypt hash, and that is a
 * considered choice rather than a shortcut. bcrypt exists to slow an offline
 * attack on a secret a person chose; these are 128 random bits, so the speed of
 * the hash is not the weak link. Verifying an unknown code against bcrypt would
 * also mean comparing it with every stored hash in turn, which at cost twelve
 * is seconds of attacker triggered work on the login path. A digest is one
 * indexed lookup. The same reasoning already governs `account_sessions`, where
 * a year long API token is stored as a plain SHA-256 digest.
 *
 * No salt and no pepper: the input is high entropy and unique, so a salt adds
 * nothing, and a pepper would tie these rows to the encryption passphrase and
 * inherit its rotation problem for no gain.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AccountRecoveryCode model.
 */
module.exports = (sequelize) => {
  const AccountRecoveryCode = sequelize.define(
    'AccountRecoveryCode',
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
      /** SHA-256 hex digest of the normalized code. */
      codeHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'code_hash',
      },
      /** Set the moment the code is spent. A code works exactly once. */
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
      tableName: 'account_recovery_codes',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['account_id', 'code_hash'] },
        { fields: ['account_id', 'consumed_at'] },
      ],
    },
  );

  return AccountRecoveryCode;
};
