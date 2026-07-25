'use strict';

const path = require('node:path');
const multer = require('multer');
const config = require('../config');
const { sanitizeFilename } = require('../core/filename');
const {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} = require('../core/errors');

/**
 * Upload middleware for translation files.
 *
 * Layered defence, cheapest check first:
 *
 *   1. Size ceiling enforced by multer, so an oversized body is cut off during
 *      streaming rather than after it is buffered.
 *   2. One file per request, so a caller cannot amplify a single upload.
 *   3. Extension allowlist, checked before anything else about the name.
 *   4. MIME allowlist, treated as a weak hint because the client sets it.
 *   5. Full filename sanitisation, which rejects traversal and control
 *      characters.
 *   6. Content verification after upload, because only parsing the bytes proves
 *      the file really is the JSON object it claims to be.
 *
 * Memory storage is deliberate: nothing touches the filesystem until the
 * content has passed every check.
 */

const storage = multer.memoryStorage();

/**
 * Rejects a part before its body is buffered.
 *
 * @param {import('express').Request} req Request.
 * @param {object} file Multer file descriptor.
 * @param {Function} callback Multer callback.
 * @returns {void}
 */
function fileFilter(req, file, callback) {
  const extension = path.extname(file.originalname ?? '').toLowerCase();

  if (!config.upload.allowedExtensions.includes(extension)) {
    callback(
      new BadRequestError(
        `Only ${config.upload.allowedExtensions.join(', ')} files may be uploaded.`,
      ),
    );
    return;
  }

  // The browser controls this header, so it is a hint rather than proof. It is
  // still checked, because it cheaply rejects obviously wrong uploads.
  const mimeType = (file.mimetype ?? '').toLowerCase().split(';')[0].trim();
  if (!config.upload.allowedMimeTypes.includes(mimeType)) {
    callback(
      new UnsupportedMediaTypeError(
        `The content type "${mimeType}" is not accepted for translation files.`,
      ),
    );
    return;
  }

  callback(null, true);
}

const multerUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxBytes,
    files: config.upload.maxFiles,
    fields: 20,
    fieldNameSize: 100,
    fieldSize: 32 * 1024,
  },
});

/**
 * Accepts a single translation file on the `file` field.
 *
 * Multer's own errors are translated into the application taxonomy so the
 * client receives the same envelope as every other failure.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {Function} next Express next handler.
 * @returns {void}
 */
function uploadTranslationFile(req, res, next) {
  multerUpload.single('file')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          next(
            new PayloadTooLargeError(
              `The file exceeds the ${Math.floor(config.upload.maxBytes / 1024)} KB limit.`,
            ),
          );
          return;
        }
        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          next(new BadRequestError('Exactly one file may be uploaded per request.'));
          return;
        }
        next(new BadRequestError(`The upload was rejected: ${error.code}.`));
        return;
      }
      next(error);
      return;
    }

    if (!req.file) {
      next(new BadRequestError('No file was uploaded. Attach one under the "file" field.'));
      return;
    }

    try {
      // Full sanitisation happens here rather than in the filter so its
      // detailed messages reach the client through the normal error path.
      req.file.safeName = sanitizeFilename(req.file.originalname, {
        allowedExtensions: config.upload.allowedExtensions,
        maxLength: config.upload.maxFilenameLength,
      });
    } catch (sanitizeError) {
      next(sanitizeError);
      return;
    }

    if (!req.file.buffer || req.file.buffer.length === 0) {
      next(new BadRequestError('The uploaded file is empty.'));
      return;
    }

    next();
  });
}

module.exports = { uploadTranslationFile };
