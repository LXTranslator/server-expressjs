'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { uploadLimiter } = require('../../middleware/rateLimit');
const chatRoutes = require('../chat/chat.routes');
const namespaceService = require('./namespace.service');
const orgService = require('../orgs/org.service');
const projectService = require('../projects/project.service');
const exportFormatService = require('../exportFormats/exportFormat.service');
const accountKeyService = require('../accountKeys/accountKey.service');
const orgSchemas = require('../orgs/org.schemas');
const projectSchemas = require('../projects/project.schemas');
const exportFormatSchemas = require('../exportFormats/exportFormat.schemas');
const accountKeySchemas = require('../accountKeys/accountKey.schemas');

const router = express.Router();

/**
 * Namespace routes.
 *
 * Every path below `/:namespace` resolves access first, so no handler ever sees
 * a namespace the caller is not entitled to. That single choke point is what
 * keeps object level authorization consistent across the module.
 */

router.use(authenticate);

/** Every namespace the caller can act in: their own, plus organizations. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const namespaces = await namespaceService.listAccessibleNamespaces(req.account);
    res.json({ data: { namespaces } });
  }),
);

/** Creates an organization namespace, owned by the caller. */
router.post(
  '/organizations',
  validate(orgSchemas.createOrganizationSchema),
  asyncHandler(async (req, res) => {
    const organization = await orgService.createOrganization(req.account, req.body);
    res.status(201).json({ data: { namespace: organization } });
  }),
);

/**
 * Resolves `:namespace` once for every nested route.
 *
 * Attaching the result to the request keeps each handler free of repeated
 * permission code, which is where inconsistencies creep in.
 */
router.use(
  '/:namespace',
  asyncHandler(async (req, res, next) => {
    const { namespace, role } = await namespaceService.resolveNamespaceAccess(
      req.account,
      req.params.namespace,
    );
    req.namespace = namespace;
    req.namespaceRole = role;
    next();
  }),
);

/** Namespace profile and the caller's role in it. */
router.get(
  '/:namespace',
  asyncHandler(async (req, res) => {
    res.json({
      data: { namespace: req.namespace.toPublicJson(), role: req.namespaceRole },
    });
  }),
);

/** Organization profile settings. */
router.patch(
  '/:namespace/settings',
  validate(orgSchemas.updateOrganizationSchema),
  asyncHandler(async (req, res) => {
    const namespace = await orgService.updateOrganization({
      namespace: req.namespace,
      role: req.namespaceRole,
      input: req.body,
    });
    res.json({ data: { namespace } });
  }),
);

/**
 * Permanently deletes an organization namespace.
 *
 * Owner only, and the caller must echo the organization identifier in the body.
 * The cascade removes every project, file and translation underneath.
 */
router.delete(
  '/:namespace',
  validate(orgSchemas.deleteOrganizationSchema),
  asyncHandler(async (req, res) => {
    await orgService.deleteOrganization({
      namespace: req.namespace,
      role: req.namespaceRole,
      input: req.body,
    });
    res.status(204).send();
  }),
);

/** Organization membership. */
router.get(
  '/:namespace/settings/members',
  asyncHandler(async (req, res) => {
    const members = await orgService.listMembers(req.namespace);
    res.json({ data: { members } });
  }),
);

router.post(
  '/:namespace/settings/members',
  validate(orgSchemas.addMemberSchema),
  asyncHandler(async (req, res) => {
    const member = await orgService.addMember({
      namespace: req.namespace,
      role: req.namespaceRole,
      input: req.body,
    });
    res.status(201).json({ data: { member } });
  }),
);

router.patch(
  '/:namespace/settings/members/:memberId',
  validate(orgSchemas.updateMemberSchema),
  asyncHandler(async (req, res) => {
    const member = await orgService.updateMemberRole({
      namespace: req.namespace,
      role: req.namespaceRole,
      memberId: req.params.memberId,
      input: req.body,
    });
    res.json({ data: { member } });
  }),
);

router.delete(
  '/:namespace/settings/members/:memberId',
  asyncHandler(async (req, res) => {
    await orgService.removeMember({
      namespace: req.namespace,
      role: req.namespaceRole,
      account: req.account,
      memberId: req.params.memberId,
    });
    res.status(204).send();
  }),
);

/*
 * Export formats.
 *
 * They hang off the namespace rather than off a project so a shape is written
 * once and every project underneath can be downloaded in it. Reading the list
 * needs no more than access to the namespace, since a member has to be able to
 * pick one on the download screen; changing the list is an ADMIN action inside
 * an organization, as every other settings change is.
 */

router.get(
  '/:namespace/export_formats',
  asyncHandler(async (req, res) => {
    const formats = await exportFormatService.listFormats(req.namespace.id);
    res.json({ data: { export_formats: formats } });
  }),
);

router.post(
  '/:namespace/export_formats',
  validate(exportFormatSchemas.createExportFormatSchema),
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    const format = await exportFormatService.createFormat(req.namespace.id, req.body);
    res.status(201).json({ data: { export_format: format } });
  }),
);

router.patch(
  '/:namespace/export_formats/:formatId',
  validate(exportFormatSchemas.updateExportFormatSchema),
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    const format = await exportFormatService.updateFormat(
      req.namespace.id,
      req.params.formatId,
      req.body,
    );
    res.json({ data: { export_format: format } });
  }),
);

router.delete(
  '/:namespace/export_formats/:formatId',
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    await exportFormatService.removeFormat(req.namespace.id, req.params.formatId);
    res.status(204).send();
  }),
);

/*
 * Account level AI credentials.
 *
 * These pay for whatever the namespace does outside a single project, so inside
 * an organization they are an owner and administrator concern in the same way
 * membership and billing are: reading the list is as privileged as changing it,
 * because the list is a statement about the organization's spending.
 *
 * That is the one place this differs from the export formats above, where any
 * member may read because picking a format is part of downloading.
 *
 * As with project credentials, no endpoint here returns a stored key at any
 * role.
 */

/**
 * Requires at least ADMIN inside an organization.
 *
 * A personal namespace has a single owner, so the check is a no operation
 * there.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function requireNamespaceAdmin(req, res, next) {
  if (req.namespace.type === 'ORG') {
    namespaceService.assertRole(req.namespaceRole, 'ADMIN');
  }
  next();
}

router.get(
  '/:namespace/settings/ai_keys',
  requireNamespaceAdmin,
  asyncHandler(async (req, res) => {
    const keys = await accountKeyService.listApiKeys(req.namespace.id);
    res.json({ data: { keys } });
  }),
);

router.post(
  '/:namespace/settings/ai_keys',
  requireNamespaceAdmin,
  validate(accountKeySchemas.addAccountApiKeySchema),
  asyncHandler(async (req, res) => {
    const key = await accountKeyService.addApiKey(req.namespace.id, req.body);
    res.status(201).json({ data: { key } });
  }),
);

router.post(
  '/:namespace/settings/ai_keys/reorder',
  requireNamespaceAdmin,
  validate(accountKeySchemas.reorderAccountApiKeysSchema),
  asyncHandler(async (req, res) => {
    const keys = await accountKeyService.reorderApiKeys(
      req.namespace.id,
      req.body.ordered_key_ids,
    );
    res.json({ data: { keys } });
  }),
);

router.patch(
  '/:namespace/settings/ai_keys/:keyId',
  requireNamespaceAdmin,
  validate(accountKeySchemas.updateAccountApiKeySchema),
  asyncHandler(async (req, res) => {
    const key = await accountKeyService.updateApiKey(
      req.namespace.id,
      req.params.keyId,
      req.body,
    );
    res.json({ data: { key } });
  }),
);

router.delete(
  '/:namespace/settings/ai_keys/:keyId',
  requireNamespaceAdmin,
  asyncHandler(async (req, res) => {
    await accountKeyService.removeApiKey(req.namespace.id, req.params.keyId);
    res.status(204).send();
  }),
);

/*
 * The assistant.
 *
 * Mounted after `:namespace` has been resolved, so every chat route inherits
 * the namespace and the caller's role in it. Any member may talk to it: the
 * tools it can call each enforce their own role, so a MEMBER asking it to
 * create a project is refused by the tool rather than by the door.
 */
router.use('/:namespace/chat', chatRoutes);

/**
 * Adds target languages across a namespace in one call.
 *
 * The per file endpoint is the right shape for one file. Adding a language to
 * everything an account owns through it means finding every project, then every
 * file, then calling it once per file, which is a loop the client should not
 * have to write and cannot make atomic anyway.
 */
router.post(
  '/:namespace/languages',
  uploadLimiter,
  validate(projectSchemas.addNamespaceLanguagesSchema),
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }

    const result = await projectService.addLanguagesAcrossProjects({
      namespace: req.namespace,
      actor: req.account,
      projectIds: req.body.project_ids,
      allProjects: req.body.all_projects === true,
      targetLangs: req.body.target_langs,
    });

    // 202: the files are updated, the translating continues on workers and the
    // client polls each file's status.
    res.status(202).json({ data: result });
  }),
);

/** Projects belonging to the namespace. */
router.get(
  '/:namespace/projects',
  asyncHandler(async (req, res) => {
    const projects = await projectService.listProjects(req.namespace.id);
    res.json({ data: { projects } });
  }),
);

router.post(
  '/:namespace/projects',
  validate(projectSchemas.createProjectSchema),
  asyncHandler(async (req, res) => {
    // Read access is enough to view a namespace, but creating inside an
    // organization requires at least ADMIN.
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    const project = await projectService.createProject(req.namespace.id, req.body, {
      actorAccountId: req.account.id,
    });
    res.status(201).json({ data: { project } });
  }),
);

module.exports = router;
