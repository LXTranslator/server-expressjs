import express from 'express';
import asyncHandler from '../../core/asyncHandler';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/authenticate';
import { uploadLimiter } from '../../middleware/rateLimit';
import { uploadTranslationFile } from '../../middleware/upload';
import requireAdmin from '../../middleware/requireAdmin';
import * as namespaceService from '../namespaces/namespace.service';
import * as projectService from './project.service';
import * as fileService from '../files/file.service';
import * as schemas from './project.schemas';
import * as fileSchemas from '../files/file.schemas';

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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
      // uploadTranslationFile has already refused a request without a file.
      content: fileService.assertJsonObject((req.file as Express.Multer.File).buffer),
      filename: (req.file as Express.Multer.File).safeName,
      sourceLang: req.body.source_lang,
      targetLangs: req.body.target_langs,
    });

    // 202: the record exists, but the pipeline is still running. The client
    // polls the file for its status.
    res.status(202).json({ data: { file: file.toPublicJson() } });
  }),
);

export default router;
