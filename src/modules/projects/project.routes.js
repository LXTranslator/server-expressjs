'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { uploadLimiter } = require('../../middleware/rateLimit');
const { uploadTranslationFile } = require('../../middleware/upload');
const namespaceService = require('../namespaces/namespace.service');
const projectService = require('./project.service');
const fileService = require('../files/file.service');
const schemas = require('./project.schemas');
const fileSchemas = require('../files/file.schemas');

const router = express.Router();

/**
 * Project routes, including credential management and file upload.
 *
 * As in the namespace router, access is resolved once for every `:projectId`
 * path so no handler repeats a permission check.
 */

router.use(authenticate);

router.use(
  '/:projectId',
  asyncHandler(async (req, res, next) => {
    const { project, namespace, role } = await namespaceService.resolveProjectAccess(
      req.account,
      req.params.projectId,
    );
    req.project = project;
    req.namespace = namespace;
    req.namespaceRole = role;
    next();
  }),
);

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
function requireProjectAdmin(req, res, next) {
  if (req.namespace.type === 'ORG') {
    namespaceService.assertRole(req.namespaceRole, 'ADMIN');
  }
  next();
}

router.get(
  '/:projectId',
  asyncHandler(async (req, res) => {
    res.json({
      data: {
        project: req.project.toPublicJson(),
        namespace: req.namespace.toMemberJson(),
        role: req.namespaceRole,
      },
    });
  }),
);

router.patch(
  '/:projectId/settings',
  requireProjectAdmin,
  validate(schemas.updateProjectSchema),
  asyncHandler(async (req, res) => {
    const project = await projectService.updateProject(req.project, req.body);
    res.json({ data: { project } });
  }),
);

router.delete(
  '/:projectId',
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    await req.project.destroy();
    res.status(204).send();
  }),
);

/*
 * Credential management.
 *
 * Every response here is masked. No endpoint in this file, at any role, returns
 * a decrypted key.
 */

router.get(
  '/:projectId/keys',
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    const keys = await projectService.listApiKeys(req.project.id);
    res.json({ data: { keys } });
  }),
);

router.post(
  '/:projectId/keys',
  requireProjectAdmin,
  validate(schemas.addApiKeySchema),
  asyncHandler(async (req, res) => {
    const key = await projectService.addApiKey(req.project.id, req.body);
    res.status(201).json({ data: { key } });
  }),
);

router.post(
  '/:projectId/keys/reorder',
  requireProjectAdmin,
  validate(schemas.reorderApiKeysSchema),
  asyncHandler(async (req, res) => {
    const keys = await projectService.reorderApiKeys(req.project.id, req.body.ordered_key_ids);
    res.json({ data: { keys } });
  }),
);

router.patch(
  '/:projectId/keys/:keyId',
  requireProjectAdmin,
  validate(schemas.updateApiKeySchema),
  asyncHandler(async (req, res) => {
    const key = await projectService.updateApiKey(req.project.id, req.params.keyId, req.body);
    res.json({ data: { key } });
  }),
);

router.delete(
  '/:projectId/keys/:keyId',
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    await projectService.removeApiKey(req.project.id, req.params.keyId);
    res.status(204).send();
  }),
);

/* Files. */

router.get(
  '/:projectId/files',
  asyncHandler(async (req, res) => {
    const files = await fileService.listFiles(req.project.id);
    res.json({ data: { files } });
  }),
);

router.post(
  '/:projectId/files',
  uploadLimiter,
  // Multer runs before validation because the metadata fields only exist once
  // the multipart body has been parsed.
  uploadTranslationFile,
  validate(fileSchemas.uploadSchema),
  asyncHandler(async (req, res) => {
    const { file } = await fileService.createUpload({
      project: req.project,
      file: req.file,
      sourceLang: req.body.source_lang,
      targetLangs: req.body.target_langs,
    });

    // 202: the record exists, but the pipeline is still running. The client
    // polls the file for its status.
    res.status(202).json({ data: { file: file.toPublicJson() } });
  }),
);

module.exports = router;
