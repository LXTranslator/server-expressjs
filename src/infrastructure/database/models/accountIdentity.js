'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `account_identities` model.
 *
 * A provider account bound to an LXTranslator account, and therefore a second
 * way to sign in to it.
 *
 * `provider_user_id` holds the provider's immutable numeric identifier, and
 * matching happens on that and nothing else. A username is renameable, and once
 * released it can be claimed by somebody else, so an account matched on one
 * would eventually be handed to whoever picked the name up next. The username
 * and email columns exist to show a person which account they linked; neither
 * is ever used to find a row.
 *
 * No provider access token is stored. It is needed once, to read the identity
 * during the callback, and is then discarded. Keeping it would make this
 * database a credential store for other people's provider accounts in exchange
 * for nothing, since a linked identity needs no ongoing API access.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AccountIdentity model.
 */
module.exports = (sequelize) => {
  const AccountIdentity = sequelize.define(
    'AccountIdentity',
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
      /** Provider name, resolved through the fixed registry. STRING, never ENUM. */
      provider: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      /** The provider's own immutable identifier. The only field ever matched on. */
      providerUserId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'provider_user_id',
      },
      /** Display only, refreshed on each sign in. Renameable, so never matched on. */
      providerUsername: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'provider_username',
      },
      /** Display only. Never used to find or merge an account. */
      providerEmail: {
        type: DataTypes.STRING(254),
        allowNull: true,
        field: 'provider_email',
      },
      linkedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'linked_at',
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_login_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'account_identities',
      updatedAt: 'updated_at',
      indexes: [
        // One provider account belongs to one LXTranslator account. The
        // constraint is what makes the race safe: insert and catch, never
        // check and then insert.
        { unique: true, fields: ['provider', 'provider_user_id'] },
        // And one linked account per provider, so the list cannot grow two
        // GitHub rows that disagree.
        { unique: true, fields: ['account_id', 'provider'] },
      ],
    },
  );

  /**
   * @returns {object} Representation safe to return to a client.
   */
  AccountIdentity.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      provider: this.provider,
      provider_username: this.providerUsername,
      provider_email: this.providerEmail,
      linked_at: this.linkedAt,
      last_login_at: this.lastLoginAt,
    };
  };

  return AccountIdentity;
};
