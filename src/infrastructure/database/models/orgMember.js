'use strict';

const { DataTypes } = require('sequelize');
const { uuidKey, reference, createdAt } = require('./columns');

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
