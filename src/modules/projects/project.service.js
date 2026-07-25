'use strict';

const config = require('../../config');
const logger = require('../../core/logger');
const { Project, ProjectApiKey } = require('../../infrastructure/database/models');
const { getProvider, isKnownProvider } = require('../../infrastructure/ai/providers');
const { encryptSecret, decryptSecret } = require('../../infrastructure/crypto/secretBox');
const { BadRequestError, ConflictError, NotFoundError } = require('../../core/errors');

/**
 * Project and credential management.
 *
 * The credential rules here are the security core of the module:
 *
 *   - A key is encrypted before it is written and is never returned to a
 *     client, in any endpoint, at any role. The interface identifies a key by
 *     its label and last four characters.
 *   - Decryption happens in exactly one place, {@link loadDecryptedKeys}, which
 *     is called only when a worker is about to make a provider request.
 *   - `priority_order` is what the fallback chain walks, so ordering is stored
 *     explicitly rather than inferred from insertion time.
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
 * @param {string} namespaceAccountId Owning namespace.
 * @param {{name: string, description?: string, ai_provider?: string, ai_model?: string}} input
 *   Validated payload.
 * @returns {Promise<object>} Client safe project.
 * @throws {ConflictError} When the namespace already has a project with that name.
 * @throws {BadRequestError} When the provider or model is not recognised.
 */
async function createProject(namespaceAccountId, input) {
  const providerName = input.ai_provider ?? config.ai.defaultProvider;
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
 * Lists a project's credentials without exposing any key material.
 *
 * @param {string} projectId Project identifier.
 * @returns {Promise<Array<object>>} Masked credential summaries.
 */
async function listApiKeys(projectId) {
  const keys = await ProjectApiKey.findAll({
    where: { projectId },
    order: [['priority_order', 'ASC'], ['created_at', 'ASC']],
  });
  return keys.map((key) => key.toPublicJson());
}

/**
 * Adds a credential to a project.
 *
 * @param {string} projectId Project identifier.
 * @param {{api_key: string, label?: string, priority_order?: number, is_active?: boolean}} input
 *   Validated payload.
 * @returns {Promise<object>} Masked credential summary.
 */
async function addApiKey(projectId, input) {
  const existingCount = await ProjectApiKey.count({ where: { projectId } });

  // Appending to the end of the chain is the least surprising default: a new
  // key should not silently displace the one already in use.
  const priorityOrder = input.priority_order ?? existingCount + 1;

  const key = await ProjectApiKey.create({
    projectId,
    apiKey: encryptSecret(input.api_key),
    label: input.label ?? null,
    lastFour: input.api_key.slice(-4),
    priorityOrder,
    isActive: input.is_active ?? true,
  });

  logger.info('Project API key added.', { projectId, keyId: key.id, priorityOrder });
  return key.toPublicJson();
}

/**
 * Updates a credential's metadata.
 *
 * The stored secret can be replaced but never read back.
 *
 * @param {string} projectId Project identifier.
 * @param {string} keyId Credential identifier.
 * @param {object} input Validated payload.
 * @returns {Promise<object>} Masked credential summary.
 * @throws {NotFoundError} When the credential does not belong to the project.
 */
async function updateApiKey(projectId, keyId, input) {
  // The `projectId` predicate is what stops a caller from editing a credential
  // that belongs to somebody else's project by guessing its identifier.
  const key = await ProjectApiKey.findOne({ where: { id: keyId, projectId } });
  if (key === null) {
    throw new NotFoundError('That API key does not exist on this project.');
  }

  const updates = {};
  if (input.label !== undefined) updates.label = input.label;
  if (input.priority_order !== undefined) updates.priorityOrder = input.priority_order;
  if (input.is_active !== undefined) updates.isActive = input.is_active;
  if (input.api_key !== undefined) {
    updates.apiKey = encryptSecret(input.api_key);
    updates.lastFour = input.api_key.slice(-4);
    updates.lastErrorAt = null;
    updates.lastErrorReason = null;
  }

  await key.update(updates);
  logger.info('Project API key updated.', { projectId, keyId });
  return key.toPublicJson();
}

/**
 * Reorders a project's credentials in one operation.
 *
 * @param {string} projectId Project identifier.
 * @param {string[]} orderedKeyIds Credential identifiers, highest priority first.
 * @returns {Promise<Array<object>>} Masked credential summaries in the new order.
 * @throws {BadRequestError} When the list does not match the project's keys.
 */
async function reorderApiKeys(projectId, orderedKeyIds) {
  const keys = await ProjectApiKey.findAll({ where: { projectId } });
  const known = new Set(keys.map((key) => key.id));

  if (orderedKeyIds.length !== known.size || !orderedKeyIds.every((id) => known.has(id))) {
    throw new BadRequestError('The order must list every API key on this project exactly once.');
  }

  await Promise.all(
    orderedKeyIds.map((id, index) =>
      ProjectApiKey.update({ priorityOrder: index + 1 }, { where: { id, projectId } }),
    ),
  );

  logger.info('Project API keys reordered.', { projectId });
  return listApiKeys(projectId);
}

/**
 * Removes a credential.
 *
 * @param {string} projectId Project identifier.
 * @param {string} keyId Credential identifier.
 * @returns {Promise<void>}
 * @throws {NotFoundError} When the credential does not belong to the project.
 */
async function removeApiKey(projectId, keyId) {
  const deleted = await ProjectApiKey.destroy({ where: { id: keyId, projectId } });
  if (deleted === 0) {
    throw new NotFoundError('That API key does not exist on this project.');
  }
  logger.info('Project API key removed.', { projectId, keyId });
}

/**
 * Loads and decrypts the credentials a worker should try, in priority order.
 *
 * This is the only place a stored key is ever decrypted. When the project has
 * no usable key and the build allows it, the built in development credential is
 * appended so the pipeline still runs with no configuration. That fallback is
 * refused in production.
 *
 * @param {object} project Project model instance.
 * @returns {Promise<Array<object>>} Decrypted credentials, highest priority first.
 */
async function loadDecryptedKeys(project) {
  const rows = await ProjectApiKey.scope('withSecret').findAll({
    where: { projectId: project.id, isActive: true },
    order: [['priority_order', 'ASC'], ['created_at', 'ASC']],
  });

  const keys = [];
  for (const row of rows) {
    try {
      keys.push({
        id: row.id,
        apiKey: decryptSecret(row.apiKey),
        label: row.label,
        lastFour: row.lastFour,
      });
    } catch (error) {
      // A key that cannot be decrypted is skipped rather than fatal, so one
      // corrupt row does not take the whole project offline.
      logger.error('A stored API key could not be decrypted.', {
        projectId: project.id,
        keyId: row.id,
        message: error.message,
      });
    }
  }

  if (keys.length === 0 && config.ai.allowDefaultApiKey && config.ai.defaultApiKey) {
    keys.push({
      id: null,
      apiKey: config.ai.defaultApiKey,
      label: 'Built in development key',
      lastFour: null,
    });
  }

  return keys;
}

/**
 * Records the outcome of a credential attempt reported by a worker.
 *
 * @param {Array<object>} attempts Attempt records from the pipeline.
 * @returns {Promise<void>}
 */
async function recordKeyAttempts(attempts) {
  for (const attempt of attempts ?? []) {
    if (attempt.keyId === null || attempt.keyId === undefined) continue;

    if (attempt.outcome === 'SUCCESS') {
      await ProjectApiKey.update(
        { lastUsedAt: new Date(), lastErrorAt: null, lastErrorReason: null },
        { where: { id: attempt.keyId } },
      );
    } else {
      await ProjectApiKey.update(
        {
          lastErrorAt: new Date(),
          lastErrorReason: String(attempt.kind ?? 'FAILED').slice(0, 200),
        },
        { where: { id: attempt.keyId } },
      );
    }
  }
}

module.exports = {
  listProjects,
  createProject,
  updateProject,
  listApiKeys,
  addApiKey,
  updateApiKey,
  reorderApiKeys,
  removeApiKey,
  loadDecryptedKeys,
  recordKeyAttempts,
  isKnownProvider,
};
