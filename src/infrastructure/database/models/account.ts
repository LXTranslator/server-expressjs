import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { AccountMfaInstance } from './accountMfa';
import type { OrgMemberInstance } from './orgMember';
import type { ProjectInstance } from './project';
import { uuidKey, createdAt } from './columns';

/** Namespace routing identifier: lowercase letters, digits and underscores. */
const USER_ID_PATTERN = /^[a-z0-9_]{3,32}$/;

/** Pragmatic email shape check; deliverability is proven by the email itself. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A namespace is either an individual user or an organization. */
const ACCOUNT_TYPES = ['USER', 'ORG'];

/** Columns of the `Account` model, as the application reads them. */
export interface AccountAttributes {
  id: string;
  userId: string;
  email: string;
  passwordHash: string;
  type: string;
  displayName: string | null;
  description: string | null;
  websiteUrl: string | null;
  credentialsChangedAt: Date;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type AccountCreationAttributes = Optional<AccountAttributes, 'id' | 'type' | 'displayName' | 'description' | 'websiteUrl' | 'credentialsChangedAt' | 'failedLoginAttempts' | 'lockedUntil' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface AccountPublicJson {
  id: AccountAttributes['id'];
  user_id: AccountAttributes['userId'];
  email: AccountAttributes['email'];
  type: AccountAttributes['type'];
  display_name: AccountAttributes['displayName'];
  description: AccountAttributes['description'];
  website_url: AccountAttributes['websiteUrl'];
  created_at: AccountAttributes['createdAt'];
}

/** What `toMemberJson` sends a client. */
interface AccountMemberJson {
  id: AccountAttributes['id'];
  user_id: AccountAttributes['userId'];
  type: AccountAttributes['type'];
  display_name: AccountAttributes['displayName'];
}

/** A loaded `Account` row. */
export interface AccountInstance
  extends Model<AccountAttributes, AccountCreationAttributes>,
    AccountAttributes {
  // Present only when the query asked for the association.
  memberships?: OrgMemberInstance[];
  organizationLinks?: OrgMemberInstance[];
  projects?: ProjectInstance[];
  mfa?: AccountMfaInstance | null;
  readonly updatedAt: Date;
  toPublicJson(): AccountPublicJson;
  toMemberJson(): AccountMemberJson;
}

/** The `Account` model class. */
export type { AccountPublicJson, AccountMemberJson };
export type AccountModel = ModelStatic<AccountInstance>;

/**
 * Defines the `accounts` model.
 *
 * There is deliberately no `users` table. An account is a namespace, and the
 * `type` column decides whether that namespace behaves as a person or as an
 * organization. This keeps project ownership uniform: a project always belongs
 * to exactly one namespace account.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {AccountModel} The Account model.
 */
export default (sequelize: Sequelize): AccountModel => {
  const Account = sequelize.define<AccountInstance>(
    'Account',
    {
      id: uuidKey(),
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
      createdAt: createdAt(),
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
  (Account.prototype as AccountInstance).toPublicJson = function toPublicJson(this: AccountInstance): AccountPublicJson {
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
  (Account.prototype as AccountInstance).toMemberJson = function toMemberJson(this: AccountInstance): AccountMemberJson {
    return {
      id: this.id,
      user_id: this.userId,
      type: this.type,
      display_name: this.displayName,
    };
  };

  return Account;
};

export { USER_ID_PATTERN, EMAIL_PATTERN, ACCOUNT_TYPES };
