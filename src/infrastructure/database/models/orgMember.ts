import { DataTypes } from 'sequelize';
import type { Model, ModelStatic, Optional, Sequelize } from 'sequelize';
import type { AccountInstance, AccountMemberJson } from './account';
import { uuidKey, reference, createdAt } from './columns';

/**
 * Membership roles, ordered from most to least privileged.
 * OWNER is assigned to the account that created the organization.
 */
const MEMBER_ROLES = ['OWNER', 'ADMIN', 'MEMBER'];

/** Ranking used for privilege comparisons; a higher number means more rights. */
const ROLE_RANK: Readonly<Record<string, number>> = Object.freeze({ MEMBER: 1, ADMIN: 2, OWNER: 3 });

/** Columns of the `OrgMember` model, as the application reads them. */
export interface OrgMemberAttributes {
  id: string;
  orgAccountId: string;
  userAccountId: string;
  role: string;
  createdAt: Date;
}

/** Columns that may be left out when a row is created. */
type OrgMemberCreationAttributes = Optional<OrgMemberAttributes, 'id' | 'role' | 'createdAt'>;

/** What `toPublicJson` sends a client. */
interface OrgMemberPublicJson {
  id: OrgMemberAttributes['id'];
  org_account_id: OrgMemberAttributes['orgAccountId'];
  user_account_id: OrgMemberAttributes['userAccountId'];
  role: OrgMemberAttributes['role'];
  created_at: OrgMemberAttributes['createdAt'];
  member?: AccountMemberJson;
}

/** A loaded `OrgMember` row. */
export interface OrgMemberInstance
  extends Model<OrgMemberAttributes, OrgMemberCreationAttributes>,
    OrgMemberAttributes {
  // Present only when the query asked for the association.
  organization?: AccountInstance;
  member?: AccountInstance;
  readonly updatedAt: Date;
  toPublicJson(): OrgMemberPublicJson;
}

/** The `OrgMember` model class. */
export type { OrgMemberPublicJson };
export type OrgMemberModel = ModelStatic<OrgMemberInstance>;

/**
 * Defines the `org_members` model, linking a USER account to an ORG account.
 *
 * @param {Sequelize} sequelize Connection instance.
 * @returns {OrgMemberModel} The OrgMember model.
 */
export default (sequelize: Sequelize): OrgMemberModel => {
  const OrgMember = sequelize.define<OrgMemberInstance>(
    'OrgMember',
    {
      id: uuidKey(),
      orgAccountId: reference('accounts', 'org_account_id'),
      userAccountId: reference('accounts', 'user_account_id'),
      role: {
        type: DataTypes.ENUM(...MEMBER_ROLES),
        allowNull: false,
        defaultValue: 'MEMBER',
      },
      createdAt: createdAt(),
    },
    {
      tableName: 'org_members',
      updatedAt: 'updated_at',
      indexes: [
        // One membership row per person per organization.
        { unique: true, fields: ['org_account_id', 'user_account_id'] },
        { fields: ['user_account_id'] },
      ],
    },
  );

  /**
   * @returns {object} Client safe representation.
   */
  (OrgMember.prototype as OrgMemberInstance).toPublicJson = function toPublicJson(this: OrgMemberInstance): OrgMemberPublicJson {
    return {
      id: this.id,
      org_account_id: this.orgAccountId,
      user_account_id: this.userAccountId,
      role: this.role,
      created_at: this.createdAt,
      member: this.member ? this.member.toMemberJson() : undefined,
    };
  };

  return OrgMember;
};

export { MEMBER_ROLES, ROLE_RANK };
