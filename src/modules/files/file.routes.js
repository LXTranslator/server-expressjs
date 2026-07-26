'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate, validated } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { uploadLimiter } = require('../../middleware/rateLimit');
const { uploadTranslationFile } = require('../../middleware/upload');
const { BadRequestError } = require('../../core/errors');
const namespaceService = require('../namespaces/namespace.service');
const fileService = require('./file.service');
const translationService = require('../translations/translation.service');
const translationSchemas = require('../translations/translation.schemas');
const fileSchemas = require('./file.schemas');
const { MASTER_LANG_CODE } = require('../../infrastructure/database/models/file');

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
 * Three shapes from one endpoint: `?lang=` returns that locale as a JSON
 * attachment, `?format=zip` returns every locale in one archive, and neither
 * returns every locale in a JSON envelope for the editor to render.
 */
router.get(
  '/:fileId/download',
  validate(fileSchemas.exportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { lang, format } = validated(req, 'query');

    if (format === 'zip') {
      const { filename, archive } = await translationService.exportArchive(req.file);

      // The name is a constant, so nothing caller controlled reaches the
      // header. Length is set explicitly because the body is a Buffer and the
      // client shows progress for a download that declares its size.
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', archive.length);
      res.send(archive);
      return;
    }

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

/**
 * Adds target languages to a file.
 *
 * Existing locales are left alone, so this costs provider quota for the new
 * languages only and cannot disturb translations already reviewed.
 */
router.post(
  '/:fileId/languages',
  validate(fileSchemas.addLanguagesSchema),
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }

    const { file, added } = await fileService.addTargetLanguages({
      file: req.file,
      project: req.project,
      targetLangs: req.body.target_langs,
    });

    // 202: the record is updated, the translating continues on a worker and the
    // client polls the file's status.
    res.status(202).json({ data: { file: file.toPublicJson(), added } });
  }),
);

/**
 * Merges a dropped document, adding only the keys the file does not have.
 *
 * A key already present is skipped entirely: its master text, its translations
 * and any manual correction survive untouched, and it costs nothing to send.
 */
router.post(
  '/:fileId/keys',
  uploadLimiter,
  (req, res, next) => {
    // Multer writes the multipart upload to req.file, which in this router is
    // already the File record set by the resolver above. Move the record aside
    // before that happens, or the handler authorises one thing and acts on
    // another.
    req.fileRecord = req.file;
    next();
  },
  uploadTranslationFile,
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    if (!req.file) {
      throw new BadRequestError('Attach a JSON translation file.');
    }

    const { file, existingKeyCount } = await fileService.mergeKeys({
      file: req.fileRecord,
      project: req.project,
      upload: req.file,
    });

    res.status(202).json({
      data: { file: file.toPublicJson(), existing_key_count: existingKeyCount },
    });
  }),
);

/** Re-runs the pipeline for a file that failed. */
router.post(
  '/:fileId/reprocess',
  asyncHandler(async (req, res) => {
    if (req.namespace.type === 'ORG') {
      namespaceService.assertRole(req.namespaceRole, 'ADMIN');
    }
    // Rebuilt from the stored master text so a rerun does not depend on the
    // original upload still being on disk, and because the master carries every
    // correction made in the editor since.
    const { content } = await fileService.buildMasterDocument(req.file.id);

    // That text is English whatever the file was uploaded in. Passing the
    // file's own source language here would translate English to English again,
    // spending quota to make the master worse.
    fileService.processFile({
      file: req.file,
      project: req.project,
      content,
      sourceLang: MASTER_LANG_CODE,
    });
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
