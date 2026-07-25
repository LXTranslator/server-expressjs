---
name: Secure File Upload
description: Layered validation of uploaded translation files in the LXTranslator server.
---

# Secure File Upload

## The layers

Cheapest check first, so a hostile upload is rejected as early as possible.

| Layer | Enforced by | Rejects |
|---|---|---|
| 1. Size | multer `limits.fileSize` | 413, cut off during streaming |
| 2. Count | multer `limits.files` | 400, more than one file |
| 3. Extension | `fileFilter` | 400, anything but `.json` |
| 4. Media type | `fileFilter` | 415, disallowed content type |
| 5. Filename | `sanitizeFilename` | 400, traversal, control characters, reserved names |
| 6. Content | `assertJsonObject` | 400, bytes that are not a JSON object |
| 7. Shape | `flattenTranslationTree` | 400, excessive depth or key count |

## Rules

1. **Memory storage until verified.** Nothing touches the filesystem until every
   check has passed.
2. **The client's content type is a hint, not proof.** It is checked because it
   is cheap, but only layer 6 actually proves what the file is.
3. **The client's filename never becomes a path.** Files are written under a
   generated UUID. The sanitised name is display metadata only.
4. **Size limits are enforced during streaming, not after buffering.** An
   oversized body must never be fully read into memory first.
5. **Depth and key ceilings are mandatory.** A deeply nested or enormous
   document is a denial of service vector against the parser and the worker.
6. **Archiving is best effort.** A failure to write the archive copy is logged
   and the upload still succeeds, because the parsed content is already stored.

## When changing the upload path

- Adding a new accepted type? Update `allowedExtensions` and
  `allowedMimeTypes` together, and add a content verification step for it.
  Extension and media type alone are never sufficient.
- Never reorder the layers so that content parsing happens before the size
  limit.
- Add a rejection test for every new rule; `tests/security.test.js` has the
  existing set.
