'use strict';

const { z } = require('zod');
const projectService = require('../../projects/project.service');
const fileService = require('../../files/file.service');
const { File } = require('../../../infrastructure/database/models');
const { MASTER_LANG_CODE } = require('../../../infrastructure/database/models/file');
const {
  targetLangsSchema,
  idSchema,
  defineArguments,
  PROJECT_ONLY,
  MAX_PROJECTS_PER_CALL,
  MAX_LANGS_PER_CALL,
  ok,
  fail,
  attempt,
  projectRef,
  resolveProject,
  reachableProjectIds,
  collectProjectTargets,
} = require('./shared');

/** Tools about the languages a project translates into. */

/**
 * Gathers every target language already in use where the caller can act.
 *
 * This is what "all languages" has to mean. The interface offers a catalogue of
 * well over a hundred locales, and adding them all would send every string of
 * every file to a provider in every one of them, from a single sentence typed
 * into a chat box. That is why the language list is capped at fifty in the
 * first place.
 *
 * The useful reading, and the bounded one, is "the languages we already
 * translate into": bring this project up to the set the others already have.
 * Gathered from every namespace the caller belongs to rather than from the
 * projects being changed, so it still answers for a project that is empty,
 * which is exactly when somebody asks.
 *
 * @param {object} context Tool context.
 * @returns {Promise<string[]>} Distinct locale codes, sorted.
 */
async function collectConfiguredLangs(context) {
  const projectIds = await reachableProjectIds(context);
  if (projectIds.length === 0) return [];

  const files = await File.findAll({ where: { projectId: projectIds } });
  const langs = new Set();

  for (const file of files) {
    for (const code of file.targetLangCodes) {
      // The master is never a target: a file already holds the English it was
      // normalised into, and asking for it would translate English to English.
      if (code !== MASTER_LANG_CODE) langs.add(code);
    }
  }

  return [...langs].sort();
}

const checkProjectLanguages = {
  name: 'check_project_languages',
  description:
    'Report the languages configured on a project: the master language, the source of each file, and every target locale.',
  ...PROJECT_ONLY,

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveProject(context, args.project_id);
    if (failure !== null) return failure;

    const files = await File.findAll({
      where: { projectId: access.project.id },
      order: [['created_at', 'ASC']],
    });

    const targets = new Set();
    for (const file of files) {
      for (const code of file.targetLangCodes) targets.add(code);
    }

    return ok({
      project: projectRef(access.project),
      master_lang_code: 'en_us',
      target_lang_codes: [...targets],
      files: files.map((file) => ({
        id: file.id,
        filename: file.filename,
        source_lang_code: file.sourceLangCode,
        target_lang_codes: file.targetLangCodes,
        status: file.status,
      })),
    });
  },
};

const addLanguages = {
  name: 'add_languages',
  description:
    'Add target languages to the files of one project, several projects, or every project in the current namespace. Add one locale, a list of them, or every locale already in use elsewhere. Languages already present are left alone.',
  ...defineArguments(
    {
      target_langs: [
        targetLangsSchema.optional(),
        {
          type: 'array',
          items: { type: 'string' },
          description:
            'Locales to add. One for a single language, several for a batch, such as ["th_th", "ja_jp"]. Omit when using all_langs.',
        },
      ],
      all_langs: [
        z.boolean().optional(),
        {
          type: 'boolean',
          description:
            'Add every language already in use across the projects the person can reach, bringing these projects up to that set. Not every locale that exists.',
        },
      ],
      project_ids: [
        z.array(idSchema).max(MAX_PROJECTS_PER_CALL).optional(),
        {
          type: 'array',
          items: { type: 'integer' },
          description: 'Projects to add them to. Omit when using all_projects.',
        },
      ],
      all_projects: [
        z.boolean().optional(),
        { type: 'boolean', description: 'Add to every project in the current namespace.' },
      ],
    },
    (schema) =>
      schema.refine((value) => value.target_langs !== undefined || value.all_langs === true, {
        message: 'Name the languages to add, or ask for all of them.',
      }),
  ),

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    let targetLangs = args.target_langs ?? [];

    if (args.all_langs === true) {
      targetLangs = await collectConfiguredLangs(context);

      if (targetLangs.length === 0) {
        return fail('No language is in use anywhere yet, so there is no set to copy.', {
          instruction:
            'Ask the person which locales they want, since there is nothing to infer them from.',
        });
      }

      if (targetLangs.length > MAX_LANGS_PER_CALL) {
        return fail(
          `That would add ${targetLangs.length} languages, more than ${MAX_LANGS_PER_CALL} in one call.`,
          {
            languages: targetLangs,
            instruction:
              'Tell the person how many there are and ask which of them to add.',
          },
        );
      }
    }

    // Unlike a platform change, the sweep here is the current namespace only.
    const { identifiers, failure } = await collectProjectTargets(args, {
      all: async () =>
        (await projectService.listProjects(context.namespace.id)).map((project) => project.id),
      ask: 'Ask which project the languages belong on, or offer to add them to every project.',
    });
    if (failure !== null) return failure;

    const applied = [];
    const skipped = [];

    for (const identifier of identifiers) {
      // Every project is authorised on its own. A list is not a permission.
      const { access, failure: denied } = await resolveProject(context, identifier, {
        admin: true,
      });
      if (denied !== null) {
        skipped.push({ project_id: identifier, reason: denied.error });
        continue;
      }

      const files = await File.findAll({ where: { projectId: access.project.id } });
      if (files.length === 0) {
        skipped.push({ project_id: identifier, reason: 'This project has no files yet.' });
        continue;
      }

      for (const file of files) {
        const { value, failure: refused } = await attempt(() =>
          fileService.addTargetLanguages({
            file,
            project: access.project,
            namespace: access.namespace,
            actor: context.actor,
            targetLangs,
          }),
        );

        if (refused === null) {
          applied.push({
            project_id: access.project.id,
            file_id: file.id,
            filename: file.filename,
            added: value.added,
          });
        } else {
          skipped.push({
            project_id: access.project.id,
            file_id: file.id,
            reason: refused.error,
          });
        }
      }
    }

    return ok({
      applied,
      skipped,
      // Named back deliberately when the set was inferred: "all languages"
      // has to resolve to something the person can see and disagree with.
      requested_langs: targetLangs,
      message:
        applied.length === 0
          ? 'No file was changed.'
          : `Started translating ${applied.length} file(s) into ${targetLangs.join(', ')}.`,
      instruction:
        applied.length === 0
          ? 'Explain why nothing changed, using the reasons listed.'
          : 'Name the languages that were added and tell the person the translation runs in the background.',
    });
  },
};

module.exports = { checkProjectLanguages, addLanguages };
