'use strict';

const { DataTypes } = require('sequelize');

/** Namespace routing identifier: lowercase letters, digits and underscores. */
const USER_ID_PATTERN = /^[a-z0-9_]{3,32}$/;

/** Pragmatic email shape check; deliverability is proven by the email itself. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A namespace is either an individual user or an organization. */
const ACCOUNT_TYPES = ['USER', 'ORG'];

/**
 * Defines the `accounts` model.
 *
 * There is deliberately no `users` table. An account is a namespace, and the
 * `type` column decides whether that namespace behaves as a person or as an
 * organization. This keeps project ownership uniform: a project always belongs
 * to exactly one namespace account.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The Account model.
 */
module.exports = (sequelize) => {
  const Account = sequelize.define(
    'Account',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.STRING(32),
        allowNull: false,
        unique: true,
        field: 'user_id',
        validate: { is: USER_ID_PATTERN },
      },
      email: {
        type: DataTypes.STRING(254),
        allowNull: false,
        unique: true,
        validate: { is: EMAIL_PATTERN },
      },
      /**
       * The schema calls this field `password (Hash)`. It is named
       * `password_hash` here so no reader can mistake it for a plaintext
       * column. It stores a bcrypt digest and nothing else.
       */
      passwordHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'password_hash',
      },
      type: {
        type: DataTypes.ENUM(...ACCOUNT_TYPES),
        allowNull: false,
        defaultValue: 'USER',
      },
      displayName: {
        type: DataTypes.STRING(120),
        allowNull: true,
        field: 'display_name',
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      websiteUrl: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'website_url',
      },
      /**
       * Any short lived token minted before this moment is rejected, so
       * changing a password immediately invalidates outstanding reset links.
       */
      credentialsChangedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'credentials_changed_at',
      },
      failedLoginAttempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'failed_login_attempts',
      },
      lockedUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'locked_until',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'accounts',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['user_id'] },
        { unique: true, fields: ['email'] },
        { fields: ['type'] },
      ],
    },
  );

  /**
   * Projects the account down to the fields that are safe to send to a client.
   *
   * Serialisation is explicit and allowlist based so a future column cannot
   * leak by simply existing.
   *
   * @returns {object} Client safe representation.
   */
  Account.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      user_id: this.userId,
      email: this.email,
      type: this.type,
      display_name: this.displayName,
      description: this.description,
      website_url: this.websiteUrl,
      created_at: this.createdAt,
    };
  };

  /**
   * The subset visible to other members of an organization.
   *
   * @returns {object} Representation without the email address.
   */
  Account.prototype.toMemberJson = function toMemberJson() {
    return {
      id: this.id,
      user_id: this.userId,
      type: this.type,
      display_name: this.displayName,
    };
  };

  return Account;
};

module.exports.USER_ID_PATTERN = USER_ID_PATTERN;
module.exports.EMAIL_PATTERN = EMAIL_PATTERN;
module.exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
