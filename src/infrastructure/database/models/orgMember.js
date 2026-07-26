'use strict';

const { DataTypes } = require('sequelize');

/**
 * Membership roles, ordered from most to least privileged.
 * OWNER is assigned to the account that created the organization.
 */
const MEMBER_ROLES = ['OWNER', 'ADMIN', 'MEMBER'];

/** Ranking used for privilege comparisons; a higher number means more rights. */
const ROLE_RANK = Object.freeze({ MEMBER: 1, ADMIN: 2, OWNER: 3 });

/**
 * Defines the `org_members` model, linking a USER account to an ORG account.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The OrgMember model.
 */
module.exports = (sequelize) => {
  const OrgMember = sequelize.define(
    'OrgMember',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      orgAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'org_account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      userAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      role: {
        type: DataTypes.ENUM(...MEMBER_ROLES),
        allowNull: false,
        defaultValue: 'MEMBER',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
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
  OrgMember.prototype.toPublicJson = function toPublicJson() {
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

module.exports.MEMBER_ROLES = MEMBER_ROLES;
module.exports.ROLE_RANK = ROLE_RANK;
