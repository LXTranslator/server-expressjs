import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import { uuidKey, reference, createdAt } from './columns';

/** Columns of the `MfaChallenge` model, as the application reads them. */
export interface MfaChallengeAttributes {
  id: string;
  accountId: string;
  tokenHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type MfaChallengeCreationAttributes = Optional<MfaChallengeAttributes, 'id' | 'attempts' | 'consumedAt' | 'createdAt'>;

/** A loaded `MfaChallenge` row. */
export interface MfaChallengeInstance
  extends Model<MfaChallengeAttributes, MfaChallengeCreationAttributes>,
    MfaChallengeAttributes {
  readonly updatedAt: Date;
}

/** The `MfaChallenge` model class. */
export type MfaChallengeModel = ModelStatic<MfaChallengeInstance>;

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
 * @param {Sequelize} sequelize Connection instance.
 * @returns {MfaChallengeModel} The MfaChallenge model.
 */
export default (sequelize: Sequelize): MfaChallengeModel => {
  const MfaChallenge = sequelize.define<MfaChallengeInstance>(
    'MfaChallenge',
    {
      id: uuidKey(),
      accountId: reference('accounts', 'account_id'),
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
      createdAt: createdAt(),
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
