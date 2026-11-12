import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import { uuidKey, reference, createdAt } from './columns';

/** Columns of the `AccountRecoveryCode` model, as the application reads them. */
export interface AccountRecoveryCodeAttributes {
  id: string;
  accountId: string;
  codeHash: string;
  consumedAt: Date | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type AccountRecoveryCodeCreationAttributes = Optional<AccountRecoveryCodeAttributes, 'id' | 'consumedAt' | 'createdAt'>;

/** A loaded `AccountRecoveryCode` row. */
export interface AccountRecoveryCodeInstance
  extends Model<AccountRecoveryCodeAttributes, AccountRecoveryCodeCreationAttributes>,
    AccountRecoveryCodeAttributes {
  readonly updatedAt: Date;
}

/** The `AccountRecoveryCode` model class. */
export type AccountRecoveryCodeModel = ModelStatic<AccountRecoveryCodeInstance>;

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
 * @param {Sequelize} sequelize Connection instance.
 * @returns {AccountRecoveryCodeModel} The AccountRecoveryCode model.
 */
export default (sequelize: Sequelize): AccountRecoveryCodeModel => {
  const AccountRecoveryCode = sequelize.define<AccountRecoveryCodeInstance>(
    'AccountRecoveryCode',
    {
      id: uuidKey(),
      accountId: reference('accounts', 'account_id'),
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
      createdAt: createdAt(),
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
