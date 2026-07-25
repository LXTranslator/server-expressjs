'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');
const { Account, OrgMember } = require('../../infrastructure/database/models');
const { assertRole } = require('../namespaces/namespace.service');
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require('../../core/errors');

/**
 * Organization namespaces and their membership.
 *
 * An organization is itself an account with `type = 'ORG'`. It has no password
 * anyone can use: the column is filled with a random value so the row satisfies
 * the schema while remaining unusable as a login. People reach an organization
 * only through their own account plus a membership row.
 */

/**
 * Creates an organization and makes the creator its owner.
 *
 * @param {object} creator Account creating the organization.
 * @param {{user_id: string, email: string, display_name?: string, description?: string}} input
 *   Validated payload.
 * @returns {Promise<object>} Client safe organization.
 * @throws {ConflictError} When the user id or email is taken.
 */
async function createOrganization(creator, input) {
  const existing = await Account.findOne({
    where: { [Op.or]: [{ userId: input.user_id }, { email: input.email }] },
  });
  if (existing !== null) {
    const field = existing.userId === input.user_id ? 'user id' : 'email address';
    throw new ConflictError(`That ${field} is already registered.`);
  }

  // Unusable by construction: nobody knows this value and it is never reset.
  const unusablePassword = await bcrypt.hash(
    crypto.randomBytes(32).toString('hex'),
    config.security.bcryptRounds,
  );

  const organization = await Account.create({
    userId: input.user_id,
    email: input.email,
    passwordHash: unusablePassword,
    type: 'ORG',
    displayName: input.display_name ?? input.user_id,
    description: input.description ?? null,
  });

  await OrgMember.create({
    orgAccountId: organization.id,
    userAccountId: creator.id,
    role: 'OWNER',
  });

  logger.info('Organization created.', {
    organizationId: organization.id,
    creatorId: creator.id,
  });

  return organization.toPublicJson();
}

/**
 * Updates an organization's profile.
 *
 * @param {object} params Update parameters.
 * @param {object} params.namespace Organization account.
 * @param {string} params.role Caller's role.
 * @param {object} params.input Validated payload.
 * @returns {Promise<object>} Client safe organization.
 * @throws {BadRequestError} When the namespace is a personal one.
 */
async function updateOrganization({ namespace, role, input }) {
  if (namespace.type !== 'ORG') {
    throw new BadRequestError('Only organization namespaces have organization settings.');
  }
  assertRole(role, 'ADMIN');

  await namespace.update({
    ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.website_url === undefined ? {} : { websiteUrl: input.website_url }),
  });

  logger.info('Organization profile updated.', { organizationId: namespace.id });
  return namespace.toPublicJson();
}

/**
 * Lists an organization's members.
 *
 * @param {object} namespace Organization account.
 * @returns {Promise<Array<object>>} Membership summaries.
 * @throws {BadRequestError} When the namespace is a personal one.
 */
async function listMembers(namespace) {
  if (namespace.type !== 'ORG') {
    throw new BadRequestError('Only organization namespaces have members.');
  }

  const members = await OrgMember.findAll({
    where: { orgAccountId: namespace.id },
    include: [{ model: Account, as: 'member' }],
    order: [['created_at', 'ASC']],
  });

  return members.map((member) => member.toPublicJson());
}

/**
 * Adds a member to an organization.
 *
 * Only an existing USER account can be added, identified by user id or email.
 *
 * @param {object} params Invitation parameters.
 * @param {object} params.namespace Organization account.
 * @param {string} params.role Caller's role.
 * @param {{identifier: string, role?: string}} params.input Validated payload.
 * @returns {Promise<object>} Membership summary.
 * @throws {NotFoundError} When no such account exists.
 * @throws {ConflictError} When the account is already a member.
 */
async function addMember({ namespace, role, input }) {
  if (namespace.type !== 'ORG') {
    throw new BadRequestError('Only organization namespaces have members.');
  }
  assertRole(role, 'ADMIN');

  const identifier = input.identifier.trim().toLowerCase();
  const invitee = await Account.findOne({
    where: {
      [Op.and]: [
        { [Op.or]: [{ userId: identifier }, { email: identifier }] },
        { type: 'USER' },
      ],
    },
  });

  if (invitee === null) {
    throw new NotFoundError('No account matches that user id or email address.');
  }

  const duplicate = await OrgMember.findOne({
    where: { orgAccountId: namespace.id, userAccountId: invitee.id },
  });
  if (duplicate !== null) {
    throw new ConflictError('That account is already a member of this organization.');
  }

  const grantedRole = input.role ?? 'MEMBER';

  // Nobody may grant a role above their own, which is what stops an ADMIN from
  // promoting somebody to OWNER and then being removed by them.
  assertRole(role, grantedRole);

  const membership = await OrgMember.create({
    orgAccountId: namespace.id,
    userAccountId: invitee.id,
    role: grantedRole,
  });

  logger.info('Organization member added.', {
    organizationId: namespace.id,
    memberId: invitee.id,
    role: grantedRole,
  });

  membership.member = invitee;
  return membership.toPublicJson();
}

/**
 * Changes a member's role.
 *
 * @param {object} params Update parameters.
 * @param {object} params.namespace Organization account.
 * @param {string} params.role Caller's role.
 * @param {string} params.memberId Membership identifier.
 * @param {{role: string}} params.input Validated payload.
 * @returns {Promise<object>} Membership summary.
 * @throws {NotFoundError} When the membership does not exist here.
 * @throws {ForbiddenError} When the change would remove the last owner.
 */
async function updateMemberRole({ namespace, role, memberId, input }) {
  assertRole(role, 'ADMIN');
  assertRole(role, input.role);

  const membership = await OrgMember.findOne({
    where: { id: memberId, orgAccountId: namespace.id },
    include: [{ model: Account, as: 'member' }],
  });
  if (membership === null) {
    throw new NotFoundError('That member does not belong to this organization.');
  }

  // An organization without an owner cannot be administered again.
  if (membership.role === 'OWNER' && input.role !== 'OWNER') {
    const owners = await OrgMember.count({
      where: { orgAccountId: namespace.id, role: 'OWNER' },
    });
    if (owners <= 1) {
      throw new ForbiddenError('An organization must keep at least one owner.');
    }
  }

  await membership.update({ role: input.role });

  logger.info('Organization member role changed.', {
    organizationId: namespace.id,
    memberId,
    role: input.role,
  });

  return membership.toPublicJson();
}

/**
 * Removes a member from an organization.
 *
 * @param {object} params Removal parameters.
 * @param {object} params.namespace Organization account.
 * @param {string} params.role Caller's role.
 * @param {object} params.account Calling account.
 * @param {string} params.memberId Membership identifier.
 * @returns {Promise<void>}
 * @throws {NotFoundError} When the membership does not exist here.
 * @throws {ForbiddenError} When the removal would remove the last owner.
 */
async function removeMember({ namespace, role, account, memberId }) {
  const membership = await OrgMember.findOne({
    where: { id: memberId, orgAccountId: namespace.id },
  });
  if (membership === null) {
    throw new NotFoundError('That member does not belong to this organization.');
  }

  // Leaving voluntarily needs no privilege; removing somebody else does.
  const isSelfRemoval = membership.userAccountId === account.id;
  if (!isSelfRemoval) {
    assertRole(role, 'ADMIN');
  }

  if (membership.role === 'OWNER') {
    const owners = await OrgMember.count({
      where: { orgAccountId: namespace.id, role: 'OWNER' },
    });
    if (owners <= 1) {
      throw new ForbiddenError('An organization must keep at least one owner.');
    }
  }

  await membership.destroy();

  logger.info('Organization member removed.', { organizationId: namespace.id, memberId });
}

module.exports = {
  createOrganization,
  updateOrganization,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
};
