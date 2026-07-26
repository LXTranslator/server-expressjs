'use strict';

const { Account, OrgMember, Project, File } = require('../../infrastructure/database/models');
const { ROLE_RANK } = require('../../infrastructure/database/models/orgMember');
const { NotFoundError, ForbiddenError } = require('../../core/errors');

/**
 * Namespace access control.
 *
 * Every object in this system hangs off a namespace account, so authorization
 * reduces to one question: may this account act on this namespace, and at what
 * role? Resolving that centrally is what prevents broken object level
 * authorization, where a caller swaps an identifier in a URL and reaches
 * somebody else's data.
 *
 * The rule is deny by default. A caller reaches a namespace only if it is their
 * own personal namespace, or if a membership row links them to the
 * organization. Nothing is inferred from the request itself.
 */

/**
 * Resolves a namespace and the caller's role within it.
 *
 * The identifier may be a routing `user_id` or a raw account id, because the
 * client routes namespaces by their readable handle.
 *
 * @param {object} account Authenticated account.
 * @param {string} identifier Namespace `user_id` or account id.
 * @returns {Promise<{namespace: object, role: string}>} Namespace and role.
 * @throws {NotFoundError} When no such namespace exists.
 * @throws {ForbiddenError} When the caller has no membership.
 */
async function resolveNamespaceAccess(account, identifier) {
  const namespace = await Account.findOne({
    where: identifier.includes('-') && identifier.length === 36
      ? { id: identifier }
      : { userId: identifier },
  });

  if (namespace === null) {
    throw new NotFoundError('That namespace does not exist.');
  }

  // A personal namespace is reachable only by the account that owns it.
  if (namespace.type === 'USER') {
    if (namespace.id !== account.id) {
      // Deliberately the same message a missing namespace produces, so this
      // endpoint cannot be used to confirm that an account exists.
      throw new NotFoundError('That namespace does not exist.');
    }
    return { namespace, role: 'OWNER' };
  }

  const membership = await OrgMember.findOne({
    where: { orgAccountId: namespace.id, userAccountId: account.id },
  });

  if (membership === null) {
    throw new NotFoundError('That namespace does not exist.');
  }

  return { namespace, role: membership.role };
}

/**
 * Asserts the caller holds at least the given role.
 *
 * @param {string} role Role the caller holds.
 * @param {string} required Minimum role required.
 * @returns {void}
 * @throws {ForbiddenError} When the caller's role is insufficient.
 */
function assertRole(role, required) {
  if ((ROLE_RANK[role] ?? 0) < (ROLE_RANK[required] ?? 0)) {
    throw new ForbiddenError(`This action requires the ${required} role.`);
  }
}

/**
 * Reads a project identifier from a request path.
 *
 * The column is an integer, so a value that is not one can never match a row.
 * Rejecting it here rather than passing it to the database matters: PostgreSQL
 * raises a type error on a malformed integer, which would surface as a 500 and
 * distinguish a bad identifier from an unauthorised one.
 *
 * @param {string|number} value Raw identifier.
 * @returns {number|null} The identifier, or null when it cannot be one.
 */
function parseProjectId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  // No leading zeros, no sign and no exponent, so one project has one spelling.
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value)) {
    return null;
  }
  return Number(value);
}

/**
 * Loads a project the caller is allowed to see.
 *
 * The project is fetched first and its namespace is then authorised, so a
 * caller cannot reach a project by guessing its identifier. Identifiers are
 * sequential and therefore trivially guessable, which changes nothing here:
 * authorization never depended on them being unpredictable.
 *
 * @param {object} account Authenticated account.
 * @param {string|number} projectId Project identifier.
 * @returns {Promise<{project: object, namespace: object, role: string}>}
 * @throws {NotFoundError} When the project does not exist or is not visible.
 */
async function resolveProjectAccess(account, projectId) {
  const id = parseProjectId(projectId);
  if (id === null) {
    throw new NotFoundError('That project does not exist.');
  }

  const project = await Project.findByPk(id);
  if (project === null) {
    throw new NotFoundError('That project does not exist.');
  }

  const { namespace, role } = await resolveNamespaceAccess(
    account,
    project.namespaceAccountId,
  );

  return { project, namespace, role };
}

/**
 * Loads a file the caller is allowed to see, together with its project.
 *
 * @param {object} account Authenticated account.
 * @param {string} fileId File identifier.
 * @returns {Promise<{file: object, project: object, namespace: object, role: string}>}
 * @throws {NotFoundError} When the file does not exist or is not visible.
 */
async function resolveFileAccess(account, fileId) {
  const file = await File.findByPk(fileId);
  if (file === null) {
    throw new NotFoundError('That file does not exist.');
  }

  const access = await resolveProjectAccess(account, file.projectId);
  return { file, ...access };
}

/**
 * Lists every namespace the account can act in: its own, plus organizations.
 *
 * @param {object} account Authenticated account.
 * @returns {Promise<Array<object>>} Namespace summaries.
 */
async function listAccessibleNamespaces(account) {
  const memberships = await OrgMember.findAll({
    where: { userAccountId: account.id },
    include: [{ model: Account, as: 'organization' }],
  });

  const organizations = memberships
    .filter((membership) => membership.organization)
    .map((membership) => ({
      ...membership.organization.toMemberJson(),
      role: membership.role,
    }));

  return [{ ...account.toMemberJson(), role: 'OWNER' }, ...organizations];
}

module.exports = {
  resolveNamespaceAccess,
  resolveProjectAccess,
  resolveFileAccess,
  listAccessibleNamespaces,
  assertRole,
  parseProjectId,
};
