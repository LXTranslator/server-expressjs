'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `ai_chat_logs` model.
 *
 * One row per exchange: what a person asked, what the assistant answered, and
 * what it cost. Conversations are stored rather than held in memory for two
 * reasons. A session survives a restart, and a long conversation can be replayed
 * to the model as a bounded window instead of in full, which is what keeps the
 * context length, and therefore the bill, from growing without limit.
 *
 * Two identity columns, and the distinction matters. `account_id` is the
 * namespace the conversation happened in, which is what decides whose
 * credentials paid for it and who may read it back. `user_id` is the person who
 * typed the prompt. When an organization's credential answers a member's
 * question, the organization is the account and the member is still the user:
 * spending is attributable to the namespace and the action stays attributable
 * to the human. Neither column can be inferred from the other.
 *
 * `user_id` is an account id, not the routing handle that `accounts.user_id`
 * holds. The name comes from the agreed schema; the association is named
 * `userAccountId` in JavaScript so no reader confuses the two.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AiChatLog model.
 */
module.exports = (sequelize) => {
  const AiChatLog = sequelize.define(
    'AiChatLog',
    {
      /**
       * Autoincrementing rather than a UUID, because this table is read in
       * insertion order far more often than it is addressed by identifier: the
       * last N turns of a session is the query the assistant makes constantly.
       */
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      /** Groups the turns of one conversation. */
      sessionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'session_id',
      },
      /** Namespace the conversation happened in, and whose credentials paid. */
      accountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      /** The person who asked, even when an organization's credential answered. */
      userAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      userPrompt: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'user_prompt',
      },
      aiAnswer: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
        field: 'ai_answer',
      },
      /** Tokens this exchange consumed. */
      tokenUsage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'token_usage',
      },
      /** Running total for the session, so a client needs no aggregate query. */
      totalTokenUsage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'total_token_usage',
      },
      /**
       * Vector for similarity search over past conversations, stored as a JSON
       * array of numbers.
       *
       * Text rather than a native vector type on purpose: the application must
       * run on SQLite with no configuration at all, and a pgvector column would
       * make PostgreSQL with an extension a requirement to boot. Nullable
       * because an account may have no embedding model configured, in which
       * case the chat works exactly as before and this stays empty.
       */
      embedding: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      /**
       * Which model produced the vector.
       *
       * Vectors from different models are not comparable, so a search has to
       * know what it is ranking. It also tells a backfill which rows are
       * genuinely missing a vector and which merely have an older one.
       */
      embeddingModel: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'embedding_model',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'ai_chat_logs',
      updatedAt: 'updated_at',
      indexes: [
        // The session window query: the last turns of one conversation.
        { fields: ['session_id', 'id'] },
        { fields: ['account_id', 'created_at'] },
        { fields: ['user_id'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   *
   * The embedding is deliberately absent. It is a derived vector of no use to a
   * client, and it is large enough that returning it would dominate the payload
   * of every history request.
   */
  AiChatLog.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      session_id: this.sessionId,
      account_id: this.accountId,
      user_id: this.userAccountId,
      user_prompt: this.userPrompt,
      ai_answer: this.aiAnswer,
      token_usage: this.tokenUsage,
      total_token_usage: this.totalTokenUsage,
      has_embedding: this.embedding !== null && this.embedding !== undefined,
      embedding_model: this.embeddingModel,
      created_at: this.createdAt,
    };
  };

  return AiChatLog;
};
