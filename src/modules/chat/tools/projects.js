'use strict';

const { z } = require('zod');
const projectService = require('../../projects/project.service');
const fileService = require('../../files/file.service');
const accountKeyService = require('../../accountKeys/accountKey.service');
const { listProviders, getProvider } = require('../../../infrastructure/ai/providers');
const { langCodeSchema } = require('../../files/file.schemas');
const {
  targetLangsSchema,
  idSchema,
  defineArguments,
  NO_ARGUMENTS,
  PROJECT_ONLY,
  MAX_PROJECTS_PER_CALL,
  ok,
  fail,
  attempt,
  projectRef,
  fileRef,
  requireAdmin,
  resolveProject,
  reachableProjectIds,
  collectProjectTargets,
} = require('./shared');

/** Tools that read and change projects: listing, creating, describing and their AI platform. */

/**
 * Reports whether a namespace can actually pay for a platform.
 *
 * A project may name any platform in the registry, exactly as the settings page
 * allows, so this never refuses. It exists so the assistant can say "set, but
 * nothing here pays for it yet" instead of letting somebody discover that when
 * a translation fails.
 *
 * The namespace is a parameter rather than read from the context because one
 * call may span several: a credential in one organization says nothing about
 * whether another can pay for the same platform.
 *
 * @param {string} namespaceAccountId Namespace owning the project.
 * @param {string} actorAccountId Person acting, whose personal keys stand behind it.
 * @param {string} providerName Platform the project will use.
 * @returns {Promise<string|null>} A warning to relay, or null when it is paid for.
 */
async function warnUnpaidPlatform(namespaceAccountId, actorAccountId, providerName) {
  const provider = getProvider(providerName);
  if (provider === null) return null;

  if (provider.requiresNetwork === false) {
    return `${provider.label} contacts no vendor. It returns the English text with a locale marker in front of it, so it translates nothing.`;
  }

  const configured = await accountKeyService.listConfiguredProviders({
    namespaceAccountId,
    actorAccountId,
  });

  if (configured.includes(providerName)) return null;

  return `No active ${provider.label} credential is on this account, so translating will fall back to the built in offline platform or fail. Add one in the namespace AI settings.`;
}

/** How a model argument is described, the same wherever a model can be named. */
const AI_MODEL_PARAMETER = Object.freeze({
  type: 'string',
  description:
    'Model on that platform, such as deepseek/deepseek-v4-flash. Omit for the platform default.',
});

/**
 * The platform fields a call named, and none it left out.
 *
 * @param {{ai_provider?: string, ai_model?: string}} args Validated arguments.
 * @returns {object} Fields for the project service.
 */
function platformChange(args) {
  return {
    ...(args.ai_provider === undefined ? {} : { ai_provider: args.ai_provider }),
    ...(args.ai_model === undefined ? {} : { ai_model: args.ai_model }),
  };
}

/**
 * Refuses a platform or model outside the registry, listing what exists.
 *
 * @param {string} error What was refused.
 * @param {string} instruction What the model should tell the person.
 * @returns {object} Tool result.
 */
function failPlatform(error, instruction) {
  return fail(error, {
    platforms: listProviders().map((entry) => ({ name: entry.name, models: entry.models })),
    instruction,
  });
}

const listProjects = {
  name: 'list_projects',
  description: 'List the projects in the namespace the conversation is currently acting in.',
  ...NO_ARGUMENTS,

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const projects = await projectService.listProjects(context.namespace.id);

    return ok({
      namespace: context.namespace.userId,
      project_count: projects.length,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
      })),
    });
  },
};

const createProject = {
  name: 'create_project',
  description:
    'Create a NEW project in the current namespace. A JSON locale file attached to the message is uploaded into it and translated; without one the project is created empty. To put a file into a project that already exists, use upload_file instead: never suggest deleting or recreating a project for that.',
  ...defineArguments({
    name: [
      z.string().trim().min(1).max(100),
      { type: 'string', description: 'Project name, unique within the namespace.' },
    ],
    description: [
      z.string().trim().max(500).optional(),
      { type: 'string', description: 'What the project is for.' },
    ],
    source_lang: [
      langCodeSchema.optional(),
      {
        type: 'string',
        description: 'Locale of the attached file, such as en_us. Defaults to en_us.',
      },
    ],
    target_langs: [
      targetLangsSchema.optional(),
      {
        type: 'array',
        items: { type: 'string' },
        description: 'Locales to translate the attached file into, such as ["th_th"].',
      },
    ],
    ai_provider: [
      z.string().trim().max(50).optional(),
      {
        type: 'string',
        description:
          'Platform the project translates on, such as openrouter. Omit to use the platform the account already holds a credential for. Call list_platforms if unsure.',
      },
    ],
    ai_model: [z.string().trim().max(100).optional(), AI_MODEL_PARAMETER],
  }),

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const denied = requireAdmin(context.namespace, context.namespaceRole);
    if (denied !== null) return denied;

    // The person asked for translation but attached nothing. Say so rather
    // than creating a project that will sit empty and look broken.
    if (args.target_langs !== undefined && context.attachment === null) {
      return fail('No file is attached to this message.', {
        instruction:
          'Ask the person to attach a JSON locale file to their message, then create the project again.',
      });
    }

    const { value: project, failure } = await attempt(
      () =>
        projectService.createProject(
          context.namespace.id,
          { name: args.name, description: args.description, ...platformChange(args) },
          { actorAccountId: context.actor.id },
        ),
      {
        instruction:
          'Ask the person for a different project name, or offer to use the existing project.',
      },
    );
    if (failure !== null) return failure;

    // The platform is part of what was created, so it is reported rather than
    // left for the person to go and check.
    const summary = {
      ...projectRef(project),
      ai_provider: project.ai_provider,
      ai_model: project.ai_model,
    };
    const warning = await warnUnpaidPlatform(
      context.namespace.id,
      context.actor.id,
      project.ai_provider,
    );
    const warned = warning === null ? {} : { warning };

    if (context.attachment === null) {
      return ok({
        project: summary,
        ...warned,
        message: `Created "${project.name}", translating on ${project.ai_provider} using ${project.ai_model}.`,
        instruction:
          'Tell the person the project is empty, and that attaching a JSON locale file to a message lets you upload it with the upload_file tool. The project never needs recreating for that.',
      });
    }

    const targetLangs = args.target_langs ?? [];
    if (targetLangs.length === 0) {
      return ok({
        project: summary,
        ...warned,
        message: `Created the project "${project.name}" but uploaded nothing.`,
        instruction: 'Ask the person which languages the attached file should be translated into.',
      });
    }

    const upload = await attempt(
      async () =>
        fileService.createUpload({
          project: await projectService.findProjectInstance(project.id),
          namespace: context.namespace,
          actor: context.actor,
          content: fileService.assertJsonObject(context.attachment.buffer),
          filename: context.attachment.safeName,
          sourceLang: args.source_lang,
          targetLangs,
        }),
      {
        project: projectRef(project),
        instruction: 'The project exists; only the upload failed. Explain both.',
      },
    );
    if (upload.failure !== null) return upload.failure;

    const { file } = upload.value;
    return ok({
      project: summary,
      file: fileRef(file),
      target_langs: targetLangs,
      ...warned,
      message: `Created "${project.name}" and started translating ${file.filename} on ${project.ai_provider}.`,
      instruction:
        'Tell the person translation is running in the background and the file status will become READY.',
    });
  },
};

const getProjectDescription = {
  name: 'get_project_description',
  description: 'Read the description of a project.',
  ...PROJECT_ONLY,

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const { access, failure } = await resolveProject(context, args.project_id);
    if (failure !== null) return failure;

    return ok({
      project: projectRef(access.project),
      description: access.project.description,
    });
  },
};

const updateProjectDescription = {
  name: 'update_project_description',
  description:
    'Replace the description of a project. Pass an empty string to clear it.',
  ...defineArguments({
    project_id: [idSchema, { type: 'integer', description: 'Project identifier.' }],
    description: [
      z.string().trim().max(500),
      { type: 'string', description: 'New description.' },
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

    const project = await projectService.updateProjectDescription(
      access.project,
      args.description,
    );

    return ok({
      project: projectRef(project),
      description: project.description,
      message: `Updated the description of "${project.name}".`,
    });
  },
};

const listPlatforms = {
  name: 'list_platforms',
  description:
    'List the AI platforms and models a project may be set to, and say which ones this account holds a credential for. Call this before setting a platform or model that was named from memory.',
  ...NO_ARGUMENTS,

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const configured = await accountKeyService.listConfiguredProviders({
      namespaceAccountId: context.namespace.id,
      actorAccountId: context.actor.id,
    });

    // The registry is the whole truth about what exists. A model naming
    // anything outside it is wrong, and saying so precisely beats guessing.
    const platforms = listProviders().map((provider) => ({
      name: provider.name,
      label: provider.label,
      default_model: provider.default_model,
      models: provider.models,
      translates: provider.requires_network,
      has_credential: configured.includes(provider.name),
    }));

    return ok({
      platforms,
      message: 'These are the platforms and models a project may use.',
      instruction:
        'Only these names exist. If the person asked for a model that is not listed, say so and offer the closest one rather than setting something else. A platform with has_credential false can be set but nothing on this account pays for it yet.',
    });
  },
};

const updateProjectAi = {
  name: 'update_project_ai',
  description:
    'Set the AI platform and model projects translate with, for example openrouter and deepseek/deepseek-v4-flash. Change one project, several at once wherever they live, or every project the person can reach. Changing the platform without naming a model uses that platform default.',
  ...defineArguments(
    {
      project_ids: [
        z.array(idSchema).max(MAX_PROJECTS_PER_CALL).optional(),
        {
          type: 'array',
          items: { type: 'integer' },
          description:
            'Projects to change. One identifier for a single project, several for a batch. They may sit in different namespaces. Omit when using all_projects.',
        },
      ],
      all_projects: [
        z.boolean().optional(),
        {
          type: 'boolean',
          description:
            'Change every project the person can reach, in their own namespace and in every organization they belong to.',
        },
      ],
      ai_provider: [
        z.string().trim().max(50).optional(),
        {
          type: 'string',
          description: 'Platform name, such as openrouter. Omit to keep the current one.',
        },
      ],
      ai_model: [z.string().trim().max(100).optional(), AI_MODEL_PARAMETER],
    },
    (schema) =>
      schema.refine((value) => value.ai_provider !== undefined || value.ai_model !== undefined, {
        message: 'Name a platform, a model, or both.',
      }),
  ),

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    // A sweep reaches every namespace the caller belongs to, which is what
    // makes "set these three, they are in different organizations" work.
    const { identifiers, failure } = await collectProjectTargets(args, {
      all: () => reachableProjectIds(context),
      ask: 'Ask which projects to change, or offer to change every project the person can reach.',
    });
    if (failure !== null) return failure;

    // An unknown platform or model would fail identically on every project,
    // so it is caught once here rather than reported as twenty skips.
    if (args.ai_provider !== undefined) {
      const provider = getProvider(args.ai_provider);
      if (provider === null) {
        return failPlatform(
          `The AI provider "${args.ai_provider}" is not supported.`,
          'Tell the person that platform does not exist, and pick from the ones listed here.',
        );
      }
      if (args.ai_model !== undefined && !provider.models.includes(args.ai_model)) {
        return failPlatform(
          `The model "${args.ai_model}" is not offered by ${provider.label}.`,
          'Tell the person that model is not offered, and pick from the ones listed here.',
        );
      }
    }

    const applied = [];
    const skipped = [];
    const warnings = new Set();

    for (const identifier of identifiers) {
      // Every project is authorised on its own. A list is not a permission,
      // and neither is a sweep: an organization the caller does not belong to
      // never appears, and one they belong to without ADMIN is skipped here.
      const { access, failure: denied } = await resolveProject(context, identifier, {
        admin: true,
      });
      if (denied !== null) {
        skipped.push({ project_id: identifier, reason: denied.error });
        continue;
      }

      // A model valid on one platform may not exist on another, so a project
      // already sitting elsewhere is skipped rather than failing the projects
      // that could take the change.
      const { value: project, failure: refused } = await attempt(() =>
        projectService.updateProject(access.project, platformChange(args)),
      );
      if (refused !== null) {
        skipped.push({ project_id: identifier, reason: refused.error });
        continue;
      }

      applied.push({
        project_id: project.id,
        name: project.name,
        namespace: access.namespace.userId,
        ai_provider: project.ai_provider,
        ai_model: project.ai_model,
      });

      // Asked per namespace, because a credential in one organization says
      // nothing about whether another can pay for the same platform.
      const warning = await warnUnpaidPlatform(
        access.namespace.id,
        context.actor.id,
        project.ai_provider,
      );
      if (warning !== null) warnings.add(`${access.namespace.userId}: ${warning}`);
    }

    if (applied.length === 0) {
      return fail('No project could be changed.', {
        skipped,
        instruction: 'Tell the person why each project was skipped.',
      });
    }

    return ok({
      applied,
      skipped,
      ...(warnings.size === 0 ? {} : { warnings: [...warnings] }),
      message:
        applied.length === 1
          ? `"${applied[0].name}" now translates on ${applied[0].ai_provider} using ${applied[0].ai_model}.`
          : `Changed ${applied.length} projects${skipped.length > 0 ? `, skipped ${skipped.length}` : ''}.`,
      instruction:
        'Existing translations are not redone by this change. Say so, and offer to re translate if the person wants the new model applied to what is already there. Report anything skipped and why.',
    });
  },
};

module.exports = {
  listProjects,
  createProject,
  getProjectDescription,
  updateProjectDescription,
  listPlatforms,
  updateProjectAi,
};
