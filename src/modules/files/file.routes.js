'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate, validated } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const namespaceService = require('../namespaces/namespace.service');
const fileService = require('./file.service');
const translationService = require('../translations/translation.service');
const translationSchemas = require('../translations/translation.schemas');
const fileSchemas = require('./file.schemas');

const router = express.Router();

/**
 * File routes: status, the translation editor, and download.
 *
 * Access is resolved from the file up through its project to its namespace, so
 * a caller cannot reach a file by guessing an identifier.
 */

router.use(authenticate);

router.use(
  '/:fileId',
  asyncHandler(async (req, res, next) => {
    const { file, project, namespace, role } = await namespaceService.resolveFileAccess(
      req.account,
      req.params.fileId,
    );
    req.file = file;
    req.project = project;
    req.namespace = namespace;
    req.namespaceRole = role;
    next();
  }),
);

/** File record, including processing status and any failure message. */
router.get(
  '/:fileId',
  asyncHandler(async (req, res) => {
    res.json({ data: { file: req.file.toPublicJson() } });
  }),
);

/** Editor payload: master text, every locale, and staleness warnings. */
router.get(
  '/:fileId/translations',
  asyncHandler(async (req, res) => {
    const data = await translationService.getEditorData(req.file);
    res.json({ data });
  }),
);

/** Applies a manual correction to one translation. */
router.patch(
  '/:fileId/translations/:translationId',
  validate(translationSchemas.updateTranslationSchema),
  asyncHandler(async (req, res) => {
    const translation = await translationService.updateTranslation({
      fileId: req.file.id,
      translationId: req.params.translationId,
      translatedText: req.body.translated_text,
    });
    res.json({ data: { translation } });
  }),
);

/** Applies a correction to a master string, restamping its fingerprint. */
router.patch(
  '/:fileId/keys/:keyId',
  validate(translationSchemas.updateMasterTextSchema),
  asyncHandler(async (req, res) => {
    const key = await translationService.updateMasterText({
      fileId: req.file.id,
      keyId: req.params.keyId,
      originalText: req.body.original_text,
    });
    res.json({ data: { key } });
  }),
);

/**
 * Downloads generated locale files.
 *
 * With `?lang=` a single document is returned as an attachment; without it,
 * every locale is returned in one JSON envelope.
 */
router.get(
  '/:fileId/download',
  validate(fileSchemas.exportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { lang } = validated(req, 'query');

    if (lang === undefined) {
      const documents = await translationService.exportAllLocales(req.file);
      res.json({ data: { files: documents } });
      return;
    }

    const { filename, document } = await translationService.exportLocale({
      file: req.file,
      langCode: lang,
    });

    // The filename is built from a locale code that has already passed a strict
    // pattern, so it cannot inject a header or a path.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(document, null, 2));
  }),
);

/** Re-runs the pipeline for a file that failed. */
router.post(
  '/:fileId/reprocess',
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    const data = await translationService.getEditorData(req.file);

    // Rebuild the source document from the stored master text so a rerun does
    // not depend on the original upload still being on disk.
    const content = JSON.stringify(
      Object.fromEntries(data.keys.map((key) => [key.key_name, key.original_text])),
    );

    fileService.processFile({ file: req.file, project: req.project, content });
    res.status(202).json({ data: { file: req.file.toPublicJson() } });
  }),
);

router.delete(
  '/:fileId',
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    await fileService.deleteFile(req.project.id, req.file.id);
    res.status(204).send();
  }),
);

module.exports = router;
