'use strict';

const { z } = require('zod');
const fileService = require('../../files/file.service');
const exportFormatService = require('../../exportFormats/exportFormat.service');
const translationService = require('../../translations/translation.service');
const { langCodeSchema } = require('../../files/file.schemas');
const { buildDownloadName, sanitizeFilename } = require('../../../core/filename');
const config = require('../../../config');
const {
  targetLangsSchema,
  idSchema,
  defineArguments,
  PROJECT_ONLY,
  MAX_DOWNLOADS_PER_TURN,
  ok,
  fail,
  attempt,
  projectRef,
  fileRef,
  resolveProject,
  resolveFile,
  checkKeyCount,
} = require('./shared');

/** Tools that put files into a project, add to them and hand them back. */

/** Inline keys as a model writes them: dotted names to English text. */
const keysSchema = z.record(z.string().min(1).max(200), z.string());

const uploadFile = {
  name: 'upload_file',
  description:
    'Upload the JSON locale file attached to this message into a project that already exists, and translate it into the given languages. Use this whenever the project is already there; create_project is only for making a new one.',
  ...defineArguments({
    project_id: [idSchema, { type: 'integer', description: 'Project to upload into.' }],
    target_langs: [
      targetLangsSchema,
      {
        type: 'array',
        items: { type: 'string' },
        description: 'Locales to translate into, such as ["ja_jp", "zh_cn"].',
      },
    ],
    source_lang: [
      langCodeSchema.optional(),
      {
        type: 'string',
        description: 'Locale of the attached file, such as en_us. Defaults to en_us.',
      },
    ],
  }),

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveProject(context, args.project_id, { admin: true });
    if (failure !== null) return failure;

    const project = projectRef(access.project);

    // Without an attachment there is nothing to upload, and the person needs
    // telling rather than the model inventing a reason it failed.
    if (context.attachment === null) {
      return fail('No file is attached to this message.', {
        project,
        instruction:
          'Ask the person to attach a JSON locale file to their message, then upload it again. The project itself is fine and does not need recreating.',
      });
    }

    const upload = await attempt(
      () =>
        fileService.createUpload({
          project: access.project,
          namespace: access.namespace,
          actor: context.actor,
          content: fileService.assertJsonObject(context.attachment.buffer),
          filename: context.attachment.safeName,
          sourceLang: args.source_lang,
          targetLangs: args.target_langs,
        }),
      {
        project,
        instruction:
          'Explain what went wrong with the upload. The project still exists, so it does not need recreating.',
      },
    );
    if (upload.failure !== null) return upload.failure;

    const { file } = upload.value;
    return ok({
      project,
      file: fileRef(file),
      target_langs: args.target_langs,
      message: `Uploaded ${file.filename} into "${access.project.name}" and started translating it.`,
      instruction:
        'Tell the person translation is running in the background and the file status will become READY.',
    });
  },
};

const listFiles = {
  name: 'list_files',
  description:
    'List the files already uploaded into a project, with the status of each.',
  ...PROJECT_ONLY,

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveProject(context, args.project_id);
    if (failure !== null) return failure;

    const files = await fileService.listFiles(access.project.id);

    return ok({
      project: projectRef(access.project),
      file_count: files.length,
      files: files.map((file) => ({
        id: file.id,
        filename: file.filename,
        status: file.status,
        key_count: file.key_count,
        target_lang_codes: file.target_lang_codes,
      })),
    });
  },
};

const createFile = {
  name: 'create_file',
  description: [
    'Create a new locale file in a project from keys named in the conversation, with no',
    'attachment involved. Use this whenever somebody dictates the strings, for example',
    '"create corp.json with hello.owner saying Hello Owner". upload_file is for a file',
    'attached to the message; this is for one described in words. Never ask somebody to',
    'attach a placeholder document in order to get a file created.',
  ].join(' '),
  ...defineArguments({
    project_id: [idSchema, { type: 'integer', description: 'Project to create the file in.' }],
    filename: [
      z.string().trim().min(1).max(120),
      {
        type: 'string',
        description: 'Name for the file, such as corp.json. The .json extension is added if missing.',
      },
    ],
    keys: [
      keysSchema,
      {
        type: 'object',
        description:
          'The strings, as English source text, for example {"hello.owner": "Hello Owner!"}. A dotted name is a path, exactly as in an uploaded document.',
        additionalProperties: { type: 'string' },
      },
    ],
    target_langs: [
      targetLangsSchema.optional(),
      {
        type: 'array',
        items: { type: 'string' },
        description: 'Locales to translate into, such as ["ja_jp", "th_th"].',
      },
    ],
    source_lang: [
      langCodeSchema.optional(),
      { type: 'string', description: 'Locale the keys are written in. Defaults to en_us.' },
    ],
  }),

  /**
   * Creates a file from keys somebody dictated.
   *
   * The absence of this was a real hole rather than an inconvenience. Every
   * way into a file went through an upload, so asked to create one from three
   * strings the assistant could only ask for a placeholder document to be
   * attached so it had something to add keys to. That is a worse version of
   * the thing being asked for, and it is the kind of workaround a person
   * reasonably reads as the product being broken.
   *
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveProject(context, args.project_id, { admin: true });
    if (failure !== null) return failure;

    const keyCount = Object.keys(args.keys).length;
    const badCount = checkKeyCount(keyCount, {
      empty: 'Ask which strings the file should hold and what each one says.',
      noun: 'strings',
    });
    if (badCount !== null) return badCount;

    // A file with nothing to translate into is refused by the service, so the
    // question is asked here rather than surfacing as a validation error the
    // person cannot act on.
    if (args.target_langs === undefined || args.target_langs.length === 0) {
      return fail('No target languages were named.', {
        instruction:
          'Ask which languages the file should be translated into, then call this again.',
      });
    }

    // Somebody saying "call it corp" means corp.json. The name is then held to
    // the rules an uploaded name is held to, since it is stored and displayed
    // exactly as one.
    const named = args.filename.toLowerCase().endsWith('.json')
      ? args.filename
      : `${args.filename}.json`;
    const { value: filename, failure: badName } = await attempt(
      () =>
        sanitizeFilename(named, {
          allowedExtensions: config.upload.allowedExtensions,
          maxLength: config.upload.maxFilenameLength,
        }),
      { instruction: 'Ask the person for a different filename.' },
    );
    if (badName !== null) return badName;

    const upload = await attempt(
      () =>
        fileService.createUpload({
          project: access.project,
          namespace: access.namespace,
          actor: context.actor,
          content: JSON.stringify(args.keys),
          filename,
          sourceLang: args.source_lang,
          targetLangs: args.target_langs,
        }),
      {
        instruction:
          'Explain what was refused. A name already used in this project needs a different one, not a new project.',
      },
    );
    if (upload.failure !== null) return upload.failure;

    const { file } = upload.value;
    return ok({
      project: projectRef(access.project),
      file: fileRef(file),
      key_count: keyCount,
      target_langs: file.targetLangCodes,
      message: `Created ${file.filename} in "${access.project.name}" with ${keyCount} key(s), translating into ${file.targetLangCodes.join(', ')}.`,
      instruction:
        'Tell the person the file exists and that translation runs in the background until its status is READY. Use add_keys to put more strings into it later, rather than creating a second file.',
    });
  },
};

const addKeys = {
  name: 'add_keys',
  description: [
    'Add new keys to a file that already exists, keeping its file id and everything',
    'already in it. An existing key is left exactly as it is, with its translations and',
    'any manual correction; only names the file does not have are added and translated,',
    'into the languages the file already carries. The keys come either from the JSON file',
    'attached to this message, or from the keys argument when somebody types them into',
    'the conversation. Use this whenever somebody wants to add, merge or append strings',
    'to a file. Never tell them a file cannot be added to, and never upload a second file',
    'to do it: that would make a new file id and pay to translate everything again.',
  ].join(' '),
  ...defineArguments({
    file_id: [idSchema, { type: 'string', description: 'File to add the keys to, from list_files.' }],
    keys: [
      keysSchema.optional(),
      {
        type: 'object',
        description:
          'Keys to add, as English source strings, for example {"menu.start": "Start"}. A dotted name is a path, exactly as in an uploaded document. Omit when a file is attached to the message.',
        additionalProperties: { type: 'string' },
      },
    ],
  }),

  /**
   * Merges keys into a file that already exists.
   *
   * The two sources are the same document by the time the service sees it.
   * What differs is only where it came from: a person dropping a file into
   * the conversation, or a person typing "add menu.start, it says Start".
   * Both are ordinary requests and neither should require going to another
   * screen, which is what the absence of this tool used to force.
   *
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveFile(context, args.file_id, { admin: true });
    if (failure !== null) return failure;

    const inlineKeys = args.keys ?? null;

    if (inlineKeys === null && context.attachment === null) {
      return fail('No keys were given and no file is attached to this message.', {
        file: { id: access.file.id, filename: access.file.filename },
        instruction:
          'Ask for the key names and their English text, or for a JSON file attached to the message. The file itself is fine and does not need recreating.',
      });
    }

    // Both at once is ambiguous rather than additive: the person meant one of
    // them, and guessing which would quietly ignore the other.
    if (inlineKeys !== null && context.attachment !== null) {
      return fail('Keys were given and a file was attached as well.', {
        instruction:
          'Ask whether to add the keys that were typed or the ones in the attached file, then call this again with only that one.',
      });
    }

    let content;
    if (inlineKeys === null) {
      const attached = await attempt(
        () => fileService.assertJsonObject(context.attachment.buffer),
        { instruction: 'Tell the person what is wrong with the attached document.' },
      );
      if (attached.failure !== null) return attached.failure;
      content = attached.value;
    } else {
      const badCount = checkKeyCount(Object.keys(inlineKeys).length, {
        empty: 'Ask which keys to add and what each one says in English.',
        noun: 'keys',
      });
      if (badCount !== null) return badCount;

      // Text, because that is what the pipeline parses. Serialising here also
      // means the typed keys go through exactly the path an uploaded document
      // does, rather than a second one that could drift from it.
      content = JSON.stringify(inlineKeys);
    }

    const { file, existingKeyCount } = await fileService.mergeKeys({
      file: access.file,
      project: access.project,
      namespace: access.namespace,
      actor: context.actor,
      content,
    });

    return ok({
      file: fileRef(file),
      project: projectRef(access.project),
      existing_key_count: existingKeyCount,
      target_langs: file.targetLangCodes,
      message: `Adding the new keys to ${file.filename}, which already held ${existingKeyCount}.`,
      instruction:
        'The file keeps the same id, and every key it already had keeps its translations untouched. Say that only the new keys are being translated, into the languages the file already has, and that this runs in the background until the file is READY again.',
    });
  },
};

const exportFile = {
  name: 'export_file',
  description: [
    'Offer the person a download of a translated file, as a button under the answer.',
    'Name a locale to offer that one language as JSON; omit it to offer every language',
    'in one zip archive. export_format chooses the shape of the documents, from the',
    'formats the namespace offers; call list_export_formats when the person describes a',
    'shape rather than naming one. filename is what the download saves as, when they ask',
    'for a particular name. Use this whenever somebody asks for a file, for their',
    'translations, or to export something: it is the only way to hand them one.',
  ].join(' '),
  ...defineArguments({
    file_id: [idSchema, { type: 'string', description: 'File to export, from list_files.' }],
    lang: [
      langCodeSchema.optional(),
      {
        type: 'string',
        description:
          'Locale to export, such as th_th. Omit to offer every locale in one zip archive.',
      },
    ],
    export_format: [
      z.string().trim().max(50).optional(),
      {
        type: 'string',
        description:
          'Shape of the documents, such as flat_key_value. Defaults to the value and hash shape.',
      },
    ],
    filename: [
      z.string().trim().min(1).max(120).optional(),
      {
        type: 'string',
        description:
          'What the download saves as, when the person asks for a particular name, such as "thai_strings". The extension is corrected to match what is actually being sent. Omit for the locale name, or langs.zip for an archive.',
      },
    ],
  }),

  /**
   * Offers a download rather than producing one.
   *
   * The document itself is never built here and never enters the result. Two
   * reasons, and both matter. A locale file is user written text, so feeding
   * it back through the model is the prompt injection surface this module
   * exists to avoid; and a file of any size would be paid for as tokens on
   * every remaining step of the loop.
   *
   * What is returned is a reference: which file, which locale, which format.
   * The browser fetches the bytes from the ordinary download endpoint, which
   * resolves access again for the person actually clicking. So the offer is
   * not a capability. Anything the model got wrong about who may read this
   * file is caught a second time, by the same code an ordinary download goes
   * through, and an offer for a file the person cannot reach simply fails
   * when it is used.
   *
   * @param {object} args Validated arguments.
   * @param {object} context Tool context, mutated on success.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveFile(context, args.file_id);
    if (failure !== null) return failure;

    if (context.downloads.length >= MAX_DOWNLOADS_PER_TURN) {
      return fail(`That is more than ${MAX_DOWNLOADS_PER_TURN} downloads for one answer.`, {
        instruction:
          'Tell the person which files are waiting and ask which of them they want.',
      });
    }

    const { value: format, failure: unknownFormat } = await attempt(
      () => exportFormatService.resolveFormat(access.namespace.id, args.export_format),
      {
        instruction:
          'Tell the person that format does not exist here, and call list_export_formats to offer the ones that do.',
      },
    );
    if (unknownFormat !== null) return unknownFormat;

    const { keyCount, locales } = await translationService.describeExport(access.file);

    if (keyCount === 0) {
      return fail('This file has nothing to download yet.', {
        file: fileRef(access.file),
        instruction:
          access.file.status === 'READY'
            ? 'Tell the person the file holds no keys.'
            : `Tell the person the file is ${access.file.status} and to try again once it is READY.`,
      });
    }

    if (args.lang !== undefined && !locales.includes(args.lang)) {
      return fail(`This file has no ${args.lang} translations yet.`, {
        available_langs: locales,
        instruction:
          'Tell the person which languages this file does have, and offer one of those or adding the one they asked for.',
      });
    }

    const isArchive = args.lang === undefined;

    /*
     * A name the person asked for is theirs; the extension is not. What is
     * being sent is a JSON document or a zip archive whatever anybody calls
     * it, and a name that disagrees turns into a file the operating system
     * opens with the wrong application.
     */
    let filename = isArchive ? translationService.ARCHIVE_FILENAME : `${args.lang}.json`;
    if (args.filename !== undefined) {
      const renamed = await attempt(
        () => buildDownloadName(args.filename, isArchive ? '.zip' : '.json'),
        { instruction: 'Ask the person for a different name, or offer to use the default one.' },
      );
      if (renamed.failure !== null) return renamed.failure;
      filename = renamed.value;
    }

    const download = {
      file_id: access.file.id,
      filename,
      lang: isArchive ? null : args.lang,
      langs: isArchive ? locales : [args.lang],
      export_format: format.formatId,
      format_name: format.name,
    };

    /*
     * Twice for the same thing is one button, not two. A model that calls
     * this again after describing it should not double the offer, and
     * somebody who asks for the same export under a different name has
     * renamed one download rather than asked for a second.
     */
    const existingIndex = context.downloads.findIndex(
      (existing) =>
        existing.file_id === download.file_id &&
        existing.lang === download.lang &&
        existing.export_format === download.export_format,
    );
    if (existingIndex === -1) {
      context.downloads.push(download);
    } else {
      context.downloads[existingIndex] = download;
    }

    return ok({
      download,
      project: projectRef(access.project),
      key_count: keyCount,
      message:
        download.lang === null
          ? `Ready to download ${locales.length} language(s) of ${access.file.filename} as ${download.filename}, written in ${format.name}.`
          : `Ready to download ${download.lang} from ${access.file.filename} as ${download.filename}, written in ${format.name}.`,
      instruction:
        'Say what the download holds, what it is called and which format it is written in. The button is already under your answer, so do not offer a link, a path or the file content.',
    });
  },
};

module.exports = { uploadFile, listFiles, createFile, addKeys, exportFile };
