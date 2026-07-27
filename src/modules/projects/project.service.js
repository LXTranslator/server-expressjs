'use strict';

const config = require('../../config');
const logger = require('../../core/logger');
const { Project } = require('../../infrastructure/database/models');
const { getProvider, isKnownProvider } = require('../../infrastructure/ai/providers');
const accountKeyService = require('../accountKeys/accountKey.service');
const { BadRequestError, ConflictError } = require('../../core/errors');

/**
 * Project settings.
 *
 * A project chooses a platform and a model. It holds no credentials of its own:
 * those belong to the namespace that owns it, and to the person acting in it,
 * and are resolved by `accountKeys/accountKey.service.js` when a provider call
 * is about to be made.
 *
 * That split is deliberate. A credential is a billing relationship and belongs
 * where the money does, which is an account. Copying the same key into every
 * project meant rotating it in every project, and meant a project could
 * outlive the account that was paying for it.
 */

/**
 * Lists projects in a namespace.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @returns {Promise<Array<object>>} Client safe projects.
 */
async function listProjects(namespaceAccountId) {
  const projects = await Project.findAll({
    where: { namespaceAccountId },
    order: [['created_at', 'DESC']],
  });
  return projects.map((project) => project.toPublicJson());
}

/**
 * Creates a project.
 *
 * Naming no platform does not mean "any platform will do". It means the caller
 * has no opinion, and the best answer to that is the platform the account can
 * actually pay for, so a project created straight after adding an OpenRouter
 * key translates through OpenRouter without anybody selecting it.
 *
 * The configured default is used only when the account has no credential at
 * all. That default is the offline mock, which returns the source text with a
 * locale marker in front of it. It is what keeps the application runnable on a
 * clean clone, and it is the wrong thing to hand somebody who has a real key:
 * it reports the file as finished and fills the editor with placeholder text
 * that looks like a translation.
 *
 * @param {string} namespaceAccountId Owning namespace.
 * @param {{name: string, description?: string, ai_provider?: string, ai_model?: string}} input
 *   Validated payload.
 * @param {object} [options] Options.
 * @param {string} [options.actorAccountId] Person creating it, whose personal
 *   credentials stand behind the namespace's own.
 * @returns {Promise<object>} Client safe project.
 * @throws {ConflictError} When the namespace already has a project with that name.
 * @throws {BadRequestError} When the provider or model is not recognised.
 */
async function createProject(namespaceAccountId, input, { actorAccountId } = {}) {
  const configured =
    input.ai_provider === undefined
      ? await accountKeyService.findConfiguredProvider({ namespaceAccountId, actorAccountId })
      : null;

  const providerName = input.ai_provider ?? configured ?? config.ai.defaultProvider;
  const provider = getProvider(providerName);

  if (provider === null) {
    throw new BadRequestError(`The AI provider "${providerName}" is not supported.`);
  }

  const model = input.ai_model ?? provider.defaultModel;
  if (!provider.models.includes(model)) {
    throw new BadRequestError(
      `The model "${model}" is not offered by ${provider.label}.`,
    );
  }

  const duplicate = await Project.findOne({
    where: { namespaceAccountId, name: input.name },
  });
  if (duplicate !== null) {
    throw new ConflictError('This namespace already has a project with that name.');
  }

  const project = await Project.create({
    namespaceAccountId,
    name: input.name,
    description: input.description ?? null,
    aiProvider: providerName,
    aiModel: model,
  });

  logger.info('Project created.', { projectId: project.id, namespaceAccountId });
  return project.toPublicJson();
}

/**
 * Updates a project's AI settings.
 *
 * @param {object} project Project model instance.
 * @param {{name?: string, description?: string, ai_provider?: string, ai_model?: string}} input
 *   Validated payload.
 * @returns {Promise<object>} Client safe project.
 * @throws {BadRequestError} When the provider or model is not recognised.
 */
async function updateProject(project, input) {
  const providerName = input.ai_provider ?? project.aiProvider;
  const provider = getProvider(providerName);

  if (provider === null) {
    throw new BadRequestError(`The AI provider "${providerName}" is not supported.`);
  }

  // Changing provider without naming a model falls back to that provider's
  // default, because the previous model almost certainly does not exist there.
  const model =
    input.ai_model ??
    (providerName === project.aiProvider ? project.aiModel : provider.defaultModel);

  if (!provider.models.includes(model)) {
    throw new BadRequestError(`The model "${model}" is not offered by ${provider.label}.`);
  }

  await project.update({
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    aiProvider: providerName,
    aiModel: model,
  });

  logger.info('Project settings updated.', { projectId: project.id });
  return project.toPublicJson();
}

/**
 * Loads a project row by identifier, without any access check of its own.
 *
 * Only for callers that have already authorised the project through
 * `namespace.service.js` and need the model instance rather than the client
 * safe projection. Never call it with an identifier taken from a request.
 *
 * @param {number} projectId Project identifier.
 * @returns {Promise<object|null>} Project model instance, or null.
 */
async function findProjectInstance(projectId) {
  return Project.findByPk(projectId);
}

/**
 * Replaces a project's description.
 *
 * Separate from {@link updateProject} because a description is the one project
 * field that carries no consequence: changing it cannot invalidate a
 * credential, retarget a provider or cost anything. Editing it should not have
 * to travel through the settings payload that can do all three.
 *
 * @param {object} project Project model instance.
 * @param {string} description New description. An empty string clears it.
 * @returns {Promise<object>} Client safe project.
 */
async function updateProjectDescription(project, description) {
  const value = typeof description === 'string' ? description.trim() : '';
  await project.update({ description: value.length === 0 ? null : value });

  logger.info('Project description updated.', { projectId: project.id });
  return project.toPublicJson();
}

/**
 * Adds target languages to every file of the named projects.
 *
 * The caller has already been authorised for the namespace, and every project
 * is filtered by that namespace here, so an identifier belonging to somebody
 * else matches nothing rather than being reported as forbidden.
 *
 * A project or file that cannot take the languages is skipped with a reason
 * instead of failing the call. Adding Thai to twelve projects where two already
 * have it should add it to ten, not refuse.
 *
 * @param {object} params Parameters.
 * @param {object} params.namespace Owning namespace account instance.
 * @param {object} params.actor Account making the request, whose personal keys
 *   pay for the work when the namespace has nothing usable left.
 * @param {Array<number|string>} [params.projectIds] Projects to change.
 * @param {boolean} [params.allProjects] Use every project in the namespace.
 * @param {string[]} params.targetLangs Locales to add.
 * @returns {Promise<{applied: Array<object>, skipped: Array<object>}>}
 * @throws {BadRequestError} When no project was named.
 */
async function addLanguagesAcrossProjects({
  namespace,
  actor,
  projectIds,
  allProjects,
  targetLangs,
}) {
  // Required lazily: the file service already depends on this module, so a
  // top level require here would be a cycle.
  const fileService = require('../files/file.service');
  const { File } = require('../../infrastructure/database/models');

  const namespaceAccountId = namespace.id;

  const projects = allProjects
    ? await Project.findAll({ where: { namespaceAccountId } })
    : await Project.findAll({ where: { namespaceAccountId, id: projectIds ?? [] } });

  if (projects.length === 0) {
    throw new BadRequestError('No project in this namespace matched that request.');
  }

  const applied = [];
  const skipped = [];

  for (const project of projects) {
    const files = await File.findAll({ where: { projectId: project.id } });

    if (files.length === 0) {
      skipped.push({ project_id: project.id, reason: 'This project has no files yet.' });
      continue;
    }

    for (const file of files) {
      try {
        const { added } = await fileService.addTargetLanguages({
          file,
          project,
          namespace,
          actor,
          targetLangs,
        });
        applied.push({
          project_id: project.id,
          file_id: file.id,
          filename: file.filename,
          added,
        });
      } catch (error) {
        if (!(error instanceof BadRequestError)) throw error;
        skipped.push({ project_id: project.id, file_id: file.id, reason: error.message });
      }
    }
  }

  logger.info('Languages added across projects.', {
    namespaceAccountId,
    projectCount: projects.length,
    appliedCount: applied.length,
  });

  return { applied, skipped };
}

module.exports = {
  listProjects,
  createProject,
  updateProject,
  findProjectInstance,
  updateProjectDescription,
  addLanguagesAcrossProjects,
  isKnownProvider,
};
