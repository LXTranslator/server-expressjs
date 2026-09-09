'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `account_mfa` model.
 *
 * One row per account that has enrolled a second factor, holding the shared
 * secret an authenticator app derives its codes from.
 *
 * This is a table rather than a pair of columns on `accounts` for a deployment
 * reason, not a modelling one. Production runs bare `sequelize.sync()`, which
 * creates missing tables and nothing else: it adds no column to a table that
 * already exists. Columns on `accounts` would appear on every fresh database
 * and in every test, and then silently not exist on a real deployment.
 *
 * `secret` never holds a plaintext value. The service layer wraps it with
 * AES-256-GCM before it is written, and the default scope keeps it out of every
 * query that does not ask for it by name.
 *
 * `confirmed_at` is what makes the factor real. Enrolment writes a row, but the
 * secret does nothing until the person proves they can read a code from it, so
 * a half finished enrolment cannot lock anybody out of their own account.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AccountMfa model.
 */
module.exports = (sequelize) => {
  const AccountMfa = sequelize.define(
    'AccountMfa',
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
      /** AES-256-GCM envelope wrapping the base32 secret. */
      secret: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      /** Null until a code derived from the secret has been verified once. */
      confirmedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'confirmed_at',
      },
      /**
       * Highest time step already spent, or null before the first use.
       *
       * Drift means a code is accepted for up to ninety seconds, so without
       * this a code read over somebody's shoulder works a second time. Every
       * acceptance must be strictly greater than what is recorded here.
       *
       * BIGINT because a time step is unbounded, and PostgreSQL hands one back
       * as a string. Comparisons belong in SQL rather than in JavaScript.
       */
      lastUsedCounter: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'last_used_counter',
      },
      lastVerifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_verified_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'account_mfa',
      updatedAt: 'updated_at',
      /**
       * The secret is excluded from every default query, so only code that
       * asks for it by name can read it. The exclusion names the attribute
       * rather than the column, because Sequelize matches attribute names and
       * a scope naming `secret_column` would quietly exclude nothing at all.
       */
      defaultScope: { attributes: { exclude: ['secret'] } },
      scopes: {
        withSecret: { attributes: { include: ['secret'] } },
      },
      indexes: [{ unique: true, fields: ['account_id'] }],
    },
  );

  /**
   * Reports whether the factor is active rather than merely enrolled.
   *
   * @returns {boolean} True once a code has been proved.
   */
  AccountMfa.prototype.isConfirmed = function isConfirmed() {
    return this.confirmedAt !== null;
  };

  /**
   * @returns {object} Representation that never contains the secret.
   */
  AccountMfa.prototype.toPublicJson = function toPublicJson() {
    return {
      enabled: this.confirmedAt !== null,
      confirmed_at: this.confirmedAt,
      last_verified_at: this.lastVerifiedAt,
    };
  };

  return AccountMfa;
};
