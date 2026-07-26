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
 * Project routes: settings, description and file upload.
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

/*
 * The description on its own.
 *
 * Separate from the settings payload because it is the one project field with
 * no consequence: changing it cannot invalidate a credential, retarget a
 * provider or cost anything. Reading it needs no more than access to the
 * project; changing it is a settings change like any other.
 */

router.get(
  '/:projectId/description',
  asyncHandler(async (req, res) => {
    res.json({
      data: { project_id: req.project.id, description: req.project.description },
    });
  }),
);

router.put(
  '/:projectId/description',
  requireProjectAdmin,
  validate(schemas.updateProjectDescriptionSchema),
  asyncHandler(async (req, res) => {
    const project = await projectService.updateProjectDescription(
      req.project,
      req.body.description,
    );
    res.json({ data: { project_id: project.id, description: project.description } });
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
 * A project holds no credentials.
 *
 * It names a platform and a model, and the credential that pays for them comes
 * from the namespace that owns it, falling back to the personal keys of whoever
 * asked. `/namespaces/:namespace/settings/ai_keys` is where those live.
 */

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
      namespace: req.namespace,
      actor: req.account,
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
