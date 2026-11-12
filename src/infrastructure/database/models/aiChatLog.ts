import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { AccountInstance } from './account';
import type { AiChatSessionInstance } from './aiChatSession';
import { reference, createdAt } from './columns';

/** Columns of the `AiChatLog` model, as the application reads them. */
export interface AiChatLogAttributes {
  id: number;
  sessionId: string;
  accountId: string;
  userAccountId: string;
  userPrompt: string;
  aiAnswer: string;
  tokenUsage: number;
  totalTokenUsage: number;
  embedding: string | null;
  embeddingModel: string | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type AiChatLogCreationAttributes = Optional<AiChatLogAttributes, 'id' | 'aiAnswer' | 'tokenUsage' | 'totalTokenUsage' | 'embedding' | 'embeddingModel' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface AiChatLogPublicJson {
  id: AiChatLogAttributes['id'];
  session_id: AiChatLogAttributes['sessionId'];
  account_id: AiChatLogAttributes['accountId'];
  user_id: AiChatLogAttributes['userAccountId'];
  user_prompt: AiChatLogAttributes['userPrompt'];
  ai_answer: AiChatLogAttributes['aiAnswer'];
  token_usage: AiChatLogAttributes['tokenUsage'];
  total_token_usage: AiChatLogAttributes['totalTokenUsage'];
  has_embedding: boolean;
  embedding_model: AiChatLogAttributes['embeddingModel'];
  created_at: AiChatLogAttributes['createdAt'];
}

/** A loaded `AiChatLog` row. */
export interface AiChatLogInstance
  extends Model<AiChatLogAttributes, AiChatLogCreationAttributes>,
    AiChatLogAttributes {
  // Present only when the query asked for the association.
  account?: AccountInstance;
  author?: AccountInstance | null;
  session?: AiChatSessionInstance;
  readonly updatedAt: Date;
  toPublicJson(): AiChatLogPublicJson;
}

/** The `AiChatLog` model class. */
export type { AiChatLogPublicJson };
export type AiChatLogModel = ModelStatic<AiChatLogInstance>;

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
 * @param {Sequelize} sequelize Connection instance.
 * @returns {AiChatLogModel} The AiChatLog model.
 */
export default (sequelize: Sequelize): AiChatLogModel => {
  const AiChatLog = sequelize.define<AiChatLogInstance>(
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
      accountId: reference('accounts', 'account_id'),
      /** The person who asked, even when an organization's credential answered. */
      userAccountId: reference('accounts', 'user_id'),
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
      createdAt: createdAt(),
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
  (AiChatLog.prototype as AiChatLogInstance).toPublicJson = function toPublicJson(this: AiChatLogInstance): AiChatLogPublicJson {
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
