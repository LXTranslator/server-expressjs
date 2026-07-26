'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `account_api_keys` model.
 *
 * The only place a provider credential is stored. Every call this application
 * makes to a vendor, whether it is translating a file inside a project or
 * answering a question in the assistant, is paid for by a row in this table.
 *
 * Credentials sit on an account rather than on a project because a credential
 * is a billing relationship, and billing belongs to whoever owns the account.
 * A project names a platform and a model and nothing more; the key that pays
 * for them is looked up here, narrowed to that platform, when the call is about
 * to be made.
 *
 * Each row names its own platform and chat model, which is what makes the
 * fallback chain useful across vendors: an organization can put its OpenRouter
 * credential first and a member's personal OpenAI credential behind it, and a
 * failure over one moves to the other.
 *
 * `api_key` never holds a plaintext credential. The service layer encrypts the
 * value with AES-256-GCM before it is written, and `last_four` exists purely so
 * the interface can identify a key without decrypting anything.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AccountApiKey model.
 */
module.exports = (sequelize) => {
  const AccountApiKey = sequelize.define(
    'AccountApiKey',
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
      /** Platform name, resolved through the fixed provider registry. */
      provider: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      /** Model used for assistant conversations on this credential. */
      chatModel: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'chat_model',
      },
      /**
       * Model used to embed conversations for later search.
       *
       * Nullable, and null is the ordinary case rather than an error. An
       * account that configures no embedding model still chats normally; the
       * embedding step is skipped and the log's vector column stays empty until
       * a model is configured and the rows are backfilled.
       */
      embeddingModel: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'embedding_model',
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
      tableName: 'account_api_keys',
      updatedAt: 'updated_at',
      /**
       * The encrypted column is excluded from every default query. Reading it
       * requires asking for it by name, which makes accidental exposure through
       * a generic `findAll` impossible.
       */
      defaultScope: { attributes: { exclude: ['apiKey'] } },
      scopes: {
        withSecret: { attributes: { include: ['apiKey'] } },
      },
      indexes: [{ fields: ['account_id', 'priority_order'] }],
    },
  );

  /**
   * @returns {object} Representation that never contains key material.
   */
  AccountApiKey.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      account_id: this.accountId,
      provider: this.provider,
      chat_model: this.chatModel,
      embedding_model: this.embeddingModel,
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

  return AccountApiKey;
};
