'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const namespaceService = require('./namespace.service');
const orgService = require('../orgs/org.service');
const projectService = require('../projects/project.service');
const exportFormatService = require('../exportFormats/exportFormat.service');
const orgSchemas = require('../orgs/org.schemas');
const projectSchemas = require('../projects/project.schemas');
const exportFormatSchemas = require('../exportFormats/exportFormat.schemas');

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
    const project = await projectService.createProject(req.namespace.id, req.body);
    res.status(201).json({ data: { project } });
  }),
);

module.exports = router;
