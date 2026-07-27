'use strict';

const config = require('../../config');
const logger = require('../../core/logger');
const { AccountApiKey } = require('../../infrastructure/database/models');
const { getProvider } = require('../../infrastructure/ai/providers');
const { encryptSecret, decryptSecret } = require('../../infrastructure/crypto/secretBox');
const { BadRequestError, NotFoundError } = require('../../core/errors');

/**
 * Account level AI credentials.
 *
 * The only credentials there are. These pay for everything the application
 * sends to a vendor: translating files inside a project and answering questions
 * in the assistant alike. A project names a platform and a model and borrows
 * the matching key from here. The rules:
 *
 *   - A key is encrypted before it is written and is never returned to a
 *     client, in any endpoint, at any role. The interface identifies a key by
 *     its label and last four characters.
 *   - Decryption happens in exactly one place, {@link loadDecryptedKeys}, which
 *     is called only when a provider request is about to be made.
 *   - `priority_order` is what the fallback chain walks, so ordering is stored
 *     explicitly rather than inferred from insertion time.
 *
 * What is new here is whose keys get walked. Inside an organization the
 * organization's credentials are tried first and the member's personal
 * credentials come after them. A member never reaches another member's keys,
 * and the organization never reaches a personal key belonging to somebody who
 * is not making the request.
 */

/**
 * Ceiling on stored credentials per account.
 *
 * Every entry is a credential the fallback chain may try, and a chain of a
 * thousand keys against a failing vendor is a thousand paid attempts.
 */
const MAX_KEYS_PER_ACCOUNT = 20;

/**
 * Validates a provider and chat model pair against the fixed registry.
 *
 * @param {string} providerName Platform name.
 * @param {string} [model] Chat model name.
 * @returns {{provider: object, chatModel: string}} Resolved pair.
 * @throws {BadRequestError} When either name is not recognised.
 */
function resolveProviderModel(providerName, model) {
  const provider = getProvider(providerName);
  if (provider === null) {
    throw new BadRequestError(`The AI provider "${providerName}" is not supported.`);
  }

  const chatModel = model ?? provider.defaultModel;
  if (!provider.models.includes(chatModel)) {
    throw new BadRequestError(`The model "${chatModel}" is not offered by ${provider.label}.`);
  }

  return { provider, chatModel };
}

/**
 * Validates an embedding model against the platform that would serve it.
 *
 * Leaving it unset is the ordinary case, not an error: an account with no
 * embedding model chats exactly as it otherwise would and simply stores no
 * vectors. Naming one a platform does not serve is an error, and for Anthropic
 * every name is, because it serves no embeddings endpoint at all.
 *
 * @param {object} provider Resolved provider adapter.
 * @param {string|null|undefined} model Embedding model name.
 * @returns {string|null} The accepted model, or null when none was named.
 * @throws {BadRequestError} When the platform does not offer that model.
 */
function resolveEmbeddingModel(provider, model) {
  if (model === undefined || model === null || model === '') return null;

  const offered = provider.embeddingModels ?? [];
  if (offered.length === 0) {
    throw new BadRequestError(
      `${provider.label} does not serve embeddings. Leave the embedding model empty, or add a credential on a platform that does.`,
    );
  }
  if (!offered.includes(model)) {
    throw new BadRequestError(
      `The embedding model "${model}" is not offered by ${provider.label}.`,
    );
  }

  return model;
}

/**
 * Lists an account's credentials without exposing any key material.
 *
 * @param {string} accountId Account identifier.
 * @returns {Promise<Array<object>>} Masked credential summaries.
 */
async function listApiKeys(accountId) {
  const keys = await AccountApiKey.findAll({
    where: { accountId },
    order: [['priority_order', 'ASC'], ['created_at', 'ASC']],
  });
  return keys.map((key) => key.toPublicJson());
}

/**
 * Adds a credential to an account.
 *
 * @param {string} accountId Account identifier.
 * @param {object} input Validated payload.
 * @returns {Promise<object>} Masked credential summary.
 * @throws {BadRequestError} When the account already holds the maximum.
 */
async function addApiKey(accountId, input) {
  const existingCount = await AccountApiKey.count({ where: { accountId } });
  if (existingCount >= MAX_KEYS_PER_ACCOUNT) {
    throw new BadRequestError(
      `An account may hold ${MAX_KEYS_PER_ACCOUNT} AI credentials. Remove one before adding another.`,
    );
  }

  const { provider, chatModel } = resolveProviderModel(input.provider, input.chat_model);
  const embeddingModel = resolveEmbeddingModel(provider, input.embedding_model);

  // Appending to the end of the chain is the least surprising default: a new
  // key should not silently displace the one already in use.
  const priorityOrder = input.priority_order ?? existingCount + 1;

  const key = await AccountApiKey.create({
    accountId,
    provider: input.provider,
    chatModel,
    embeddingModel,
    apiKey: encryptSecret(input.api_key),
    label: input.label ?? null,
    lastFour: input.api_key.slice(-4),
    priorityOrder,
    isActive: input.is_active ?? true,
  });

  logger.info('Account API key added.', { accountId, keyId: key.id, priorityOrder });
  return key.toPublicJson();
}

/**
 * Updates a credential's metadata.
 *
 * The stored secret can be replaced but never read back.
 *
 * @param {string} accountId Account identifier.
 * @param {string} keyId Credential identifier.
 * @param {object} input Validated payload.
 * @returns {Promise<object>} Masked credential summary.
 * @throws {NotFoundError} When the credential does not belong to the account.
 */
async function updateApiKey(accountId, keyId, input) {
  // The `accountId` predicate is what stops a caller from editing a credential
  // that belongs to another namespace by guessing its identifier.
  const key = await AccountApiKey.findOne({ where: { id: keyId, accountId } });
  if (key === null) {
    throw new NotFoundError('That API key does not exist on this account.');
  }

  const updates = {};

  const platformChanged = input.provider !== undefined && input.provider !== key.provider;

  if (input.provider !== undefined || input.chat_model !== undefined) {
    const providerName = input.provider ?? key.provider;
    // Changing platform without naming a model falls back to that platform's
    // default, because the previous model almost certainly does not exist there.
    const model = input.chat_model ?? (platformChanged ? undefined : key.chatModel);
    const resolved = resolveProviderModel(providerName, model);
    updates.provider = providerName;
    updates.chatModel = resolved.chatModel;
  }

  if (input.embedding_model !== undefined || platformChanged) {
    const { provider } = resolveProviderModel(
      updates.provider ?? key.provider,
      updates.chatModel ?? key.chatModel,
    );
    // Moving platform drops an embedding model the new one cannot serve rather
    // than failing the whole update, since the caller was changing platform and
    // not asking anything about embeddings.
    const wanted = input.embedding_model !== undefined ? input.embedding_model : key.embeddingModel;
    const offered = provider.embeddingModels ?? [];
    updates.embeddingModel =
      input.embedding_model === undefined && !offered.includes(wanted)
        ? null
        : resolveEmbeddingModel(provider, wanted);
  }

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
  logger.info('Account API key updated.', { accountId, keyId });
  return key.toPublicJson();
}

/**
 * Reorders an account's credentials in one operation.
 *
 * @param {string} accountId Account identifier.
 * @param {string[]} orderedKeyIds Credential identifiers, highest priority first.
 * @returns {Promise<Array<object>>} Masked credential summaries in the new order.
 * @throws {BadRequestError} When the list does not match the account's keys.
 */
async function reorderApiKeys(accountId, orderedKeyIds) {
  const keys = await AccountApiKey.findAll({ where: { accountId } });
  const known = new Set(keys.map((key) => key.id));

  if (orderedKeyIds.length !== known.size || !orderedKeyIds.every((id) => known.has(id))) {
    throw new BadRequestError('The order must list every API key on this account exactly once.');
  }

  await Promise.all(
    orderedKeyIds.map((id, index) =>
      AccountApiKey.update({ priorityOrder: index + 1 }, { where: { id, accountId } }),
    ),
  );

  logger.info('Account API keys reordered.', { accountId });
  return listApiKeys(accountId);
}

/**
 * Removes a credential.
 *
 * @param {string} accountId Account identifier.
 * @param {string} keyId Credential identifier.
 * @returns {Promise<void>}
 * @throws {NotFoundError} When the credential does not belong to the account.
 */
async function removeApiKey(accountId, keyId) {
  const deleted = await AccountApiKey.destroy({ where: { id: keyId, accountId } });
  if (deleted === 0) {
    throw new NotFoundError('That API key does not exist on this account.');
  }
  logger.info('Account API key removed.', { accountId, keyId });
}

/**
 * Loads and decrypts one account's credentials in priority order.
 *
 * @param {string} accountId Account identifier.
 * @param {string} origin Where the credential came from, recorded on each entry.
 * @returns {Promise<Array<object>>} Decrypted credentials.
 */
async function loadForAccount(accountId, origin) {
  const rows = await AccountApiKey.scope('withSecret').findAll({
    where: { accountId, isActive: true },
    order: [['priority_order', 'ASC'], ['created_at', 'ASC']],
  });

  const keys = [];
  for (const row of rows) {
    try {
      keys.push({
        id: row.id,
        accountId: row.accountId,
        origin,
        provider: row.provider,
        chatModel: row.chatModel,
        embeddingModel: row.embeddingModel,
        apiKey: decryptSecret(row.apiKey),
        label: row.label,
        lastFour: row.lastFour,
      });
    } catch (error) {
      // A key that cannot be decrypted is skipped rather than fatal, so one
      // corrupt row does not take the whole account offline.
      logger.error('A stored account API key could not be decrypted.', {
        accountId,
        keyId: row.id,
        message: error.message,
      });
    }
  }

  return keys;
}

/**
 * Names the platform an account can actually pay for, highest priority first.
 *
 * Used to choose the platform of a new project. Without it a project falls back
 * to the configured default, which is the offline mock, and an account that has
 * carefully added a real credential gets projects that translate to placeholder
 * text and report themselves as finished.
 *
 * Nothing is decrypted here. Choosing a default needs the name of a platform,
 * not the secret that pays for it, and the one function allowed to decrypt
 * should stay the one that is about to make a provider call.
 *
 * The organization is asked first and the person second, matching the order the
 * chain is walked, so a new project in an organization defaults to what the
 * organization pays for rather than to a member's personal vendor.
 *
 * @param {object} params Parameters.
 * @param {string} params.namespaceAccountId Namespace the project belongs to.
 * @param {string} [params.actorAccountId] Person creating it.
 * @returns {Promise<string|null>} A platform name, or null when nothing is configured.
 */
async function findConfiguredProvider({ namespaceAccountId, actorAccountId }) {
  const accountIds = [namespaceAccountId, actorAccountId].filter(
    (id, index, all) => typeof id === 'string' && all.indexOf(id) === index,
  );

  for (const accountId of accountIds) {
    const row = await AccountApiKey.findOne({
      where: { accountId, isActive: true },
      order: [['priority_order', 'ASC'], ['created_at', 'ASC']],
    });

    // A stored platform is still checked against the registry: a row written
    // before a platform was withdrawn must not select an adapter that is gone.
    if (row !== null && getProvider(row.provider) !== null) return row.provider;
  }

  return null;
}

/**
 * Builds the credential chain for one person acting in one namespace.
 *
 * Inside an organization the organization pays first: its credentials come
 * first in the chain, in their own priority order, and the caller's personal
 * credentials follow. A revoked, throttled or exhausted organization key
 * therefore falls through to the person's own key instead of failing the
 * request, which is the difference between an expired company card stopping one
 * purchase and stopping the whole team.
 *
 * Only ever the caller's own personal keys. Nothing here can reach a credential
 * belonging to another member.
 *
 * This is the only place a stored account credential is decrypted. When neither
 * account has a usable key and the build allows it, the built in development
 * credential is appended so the assistant runs with no configuration at all.
 * That fallback is refused in production.
 *
 * A `provider` narrows the chain to credentials for one platform, which is what
 * the translation pipeline needs: a project picks its platform and model, and
 * only a credential for that platform can pay for it. The assistant passes no
 * provider, because it takes the platform from whichever credential answers.
 *
 * @param {object} params Chain parameters.
 * @param {object} params.namespace Namespace account the caller is acting in.
 * @param {object} params.actor Authenticated account making the request.
 * @param {string} [params.provider] Platform to narrow the chain to.
 * @returns {Promise<Array<object>>} Decrypted credentials, highest priority first.
 */
async function loadDecryptedKeys({ namespace, actor, provider }) {
  const organizationKeys =
    namespace.type === 'ORG' ? await loadForAccount(namespace.id, 'ORG') : [];

  // A personal namespace is only ever reachable by the account that owns it, so
  // this is the caller's own chain in both cases: either the whole chain, or
  // the tail of it behind the organization's.
  const personalKeys = await loadForAccount(actor.id, 'USER');

  const chain = [...organizationKeys, ...personalKeys];
  const keys =
    provider === undefined ? chain : chain.filter((key) => key.provider === provider);

  if (keys.length === 0 && config.ai.allowDefaultApiKey && config.ai.defaultApiKey) {
    keys.push({
      id: null,
      accountId: null,
      origin: 'BUILT_IN',
      // Named as whatever was asked for, so the offline provider still answers
      // a project configured for it with nothing else set up anywhere.
      provider: provider ?? config.ai.defaultProvider,
      chatModel: config.ai.defaultModel,
      embeddingModel: null,
      apiKey: config.ai.defaultApiKey,
      label: 'Built in development key',
      lastFour: null,
    });
  }

  return keys;
}

/**
 * Finds the credential that should produce embeddings for an account.
 *
 * The first entry in the chain that names an embedding model wins, so an
 * organization can pay for search while a member's personal credential only
 * answers chat, or the reverse. No embedding model anywhere is a normal state
 * and returns null rather than raising.
 *
 * @param {object} params Chain parameters.
 * @param {object} params.namespace Namespace account the caller is acting in.
 * @param {object} params.actor Authenticated account making the request.
 * @returns {Promise<object|null>} Credential to embed with, or null.
 */
async function loadEmbeddingKey({ namespace, actor }) {
  const keys = await loadDecryptedKeys({ namespace, actor });
  return keys.find((key) => typeof key.embeddingModel === 'string' && key.embeddingModel.length > 0)
    ?? null;
}

/**
 * Records the outcome of a credential attempt.
 *
 * @param {Array<object>} attempts Attempt records from the fallback executor.
 * @returns {Promise<void>}
 */
async function recordKeyAttempts(attempts) {
  for (const attempt of attempts ?? []) {
    if (attempt.keyId === null || attempt.keyId === undefined) continue;

    if (attempt.outcome === 'SUCCESS') {
      await AccountApiKey.update(
        { lastUsedAt: new Date(), lastErrorAt: null, lastErrorReason: null },
        { where: { id: attempt.keyId } },
      );
    } else {
      await AccountApiKey.update(
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
  listApiKeys,
  addApiKey,
  updateApiKey,
  reorderApiKeys,
  removeApiKey,
  findConfiguredProvider,
  loadDecryptedKeys,
  loadEmbeddingKey,
  recordKeyAttempts,
  resolveProviderModel,
  resolveEmbeddingModel,
  MAX_KEYS_PER_ACCOUNT,
};
