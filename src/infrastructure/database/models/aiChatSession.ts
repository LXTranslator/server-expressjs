import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { AccountInstance } from './account';
import type { AiChatLogInstance } from './aiChatLog';
import { uuidKey, reference, createdAt } from './columns';

/** Columns of the `AiChatSession` model, as the application reads them. */
export interface AiChatSessionAttributes {
  id: string;
  accountId: string;
  userAccountId: string;
  title: string | null;
  turnCount: number;
  totalTokenUsage: number;
  lastMessageAt: Date | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type AiChatSessionCreationAttributes = Optional<AiChatSessionAttributes, 'id' | 'title' | 'turnCount' | 'totalTokenUsage' | 'lastMessageAt' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface AiChatSessionPublicJson {
  id: AiChatSessionAttributes['id'];
  account_id: AiChatSessionAttributes['accountId'];
  user_id: AiChatSessionAttributes['userAccountId'];
  title: AiChatSessionAttributes['title'];
  turn_count: AiChatSessionAttributes['turnCount'];
  total_token_usage: AiChatSessionAttributes['totalTokenUsage'];
  last_message_at: AiChatSessionAttributes['lastMessageAt'];
  created_at: AiChatSessionAttributes['createdAt'];
}

/** A loaded `AiChatSession` row. */
export interface AiChatSessionInstance
  extends Model<AiChatSessionAttributes, AiChatSessionCreationAttributes>,
    AiChatSessionAttributes {
  // Present only when the query asked for the association.
  account?: AccountInstance;
  author?: AccountInstance | null;
  turns?: AiChatLogInstance[];
  readonly updatedAt: Date;
  toPublicJson(): AiChatSessionPublicJson;
}

/** The `AiChatSession` model class. */
export type { AiChatSessionPublicJson };
export type AiChatSessionModel = ModelStatic<AiChatSessionInstance>;

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
 * @param {Sequelize} sequelize Connection instance.
 * @returns {AiChatSessionModel} The AiChatSession model.
 */
export default (sequelize: Sequelize): AiChatSessionModel => {
  const AiChatSession = sequelize.define<AiChatSessionInstance>(
    'AiChatSession',
    {
      /**
       * The session identifier itself, minted by the application rather than by
       * the database, because the identifier exists in the turn that creates the
       * conversation and has to be the same one the log rows carry.
       */
      id: uuidKey(),
      /** Namespace the conversation happened in, and whose credentials paid. */
      accountId: reference('accounts', 'account_id'),
      /** The person whose conversation it is. */
      userAccountId: reference('accounts', 'user_id'),
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
      createdAt: createdAt(),
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
  (AiChatSession.prototype as AiChatSessionInstance).toPublicJson = function toPublicJson(this: AiChatSessionInstance): AiChatSessionPublicJson {
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
