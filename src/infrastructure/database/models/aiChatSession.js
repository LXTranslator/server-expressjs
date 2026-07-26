'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `ai_chat_sessions` model.
 *
 * One row per conversation. Before this table a session was nothing but a UUID
 * repeated across `ai_chat_logs`, which meant a conversation had no name, no
 * record of when it was last spoken to, and no existence at all until somebody
 * had already said something into it.
 *
 * It also meant a session identifier was unowned. A caller holding a UUID from
 * anywhere could post into it, and the turn would be written under that
 * caller's own account, quietly interleaving two people's conversations under
 * one identifier. A session row makes the identifier something that belongs to
 * a namespace and a person, so continuing one is a permission check rather than
 * a coincidence of UUIDs.
 *
 * `title` is nullable and stays null until it is worth naming. The service
 * derives one from the opening question so a list is readable without anybody
 * naming anything, and a person renaming a conversation replaces it. A derived
 * title and a chosen one are the same column on purpose: once renamed, nothing
 * should quietly rewrite it.
 *
 * `turn_count` and `total_token_usage` are denormalised from the log rows. A
 * conversation list would otherwise be an aggregate over the largest table in
 * the schema, run on every page load, to render two numbers.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AiChatSession model.
 */
module.exports = (sequelize) => {
  const AiChatSession = sequelize.define(
    'AiChatSession',
    {
      /**
       * The session identifier itself, minted by the application rather than by
       * the database, because the identifier exists in the turn that creates the
       * conversation and has to be the same one the log rows carry.
       */
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
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
      /** The person whose conversation it is. */
      userAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      /**
       * What the conversation is called.
       *
       * Null until the first turn names it. Bounded well below the prompt limit
       * because this is a label in a list, not a summary.
       */
      title: {
        type: DataTypes.STRING(120),
        allowNull: true,
      },
      /** Turns recorded so far, kept in step as each one is written. */
      turnCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'turn_count',
      },
      /** Running token total for the whole conversation. */
      totalTokenUsage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'total_token_usage',
      },
      /**
       * When it was last spoken to.
       *
       * Separate from `updated_at`, which also moves when a conversation is
       * merely renamed. Sorting a list by activity should not be disturbed by
       * somebody fixing a typo in a title.
       */
      lastMessageAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_message_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'ai_chat_sessions',
      updatedAt: 'updated_at',
      indexes: [
        // The list query: this person's conversations in this namespace, most
        // recently used first.
        { fields: ['account_id', 'user_id', 'last_message_at'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  AiChatSession.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      account_id: this.accountId,
      user_id: this.userAccountId,
      title: this.title,
      turn_count: this.turnCount,
      total_token_usage: this.totalTokenUsage,
      last_message_at: this.lastMessageAt,
      created_at: this.createdAt,
    };
  };

  return AiChatSession;
};
