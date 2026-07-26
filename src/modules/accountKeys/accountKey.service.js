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
 * A project's credentials pay for that project's translation pipeline. These
 * pay for whatever an account does outside a single project, which today means
 * the assistant. The rules are the same ones the project credentials follow:
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

  const { chatModel } = resolveProviderModel(input.provider, input.chat_model);

  // Appending to the end of the chain is the least surprising default: a new
  // key should not silently displace the one already in use.
  const priorityOrder = input.priority_order ?? existingCount + 1;

  const key = await AccountApiKey.create({
    accountId,
    provider: input.provider,
    chatModel,
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

  if (input.provider !== undefined || input.chat_model !== undefined) {
    const providerName = input.provider ?? key.provider;
    // Changing platform without naming a model falls back to that platform's
    // default, because the previous model almost certainly does not exist there.
    const model =
      input.chat_model ?? (providerName === key.provider ? key.chatModel : undefined);
    const resolved = resolveProviderModel(providerName, model);
    updates.provider = providerName;
    updates.chatModel = resolved.chatModel;
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
 * @param {object} params Chain parameters.
 * @param {object} params.namespace Namespace account the caller is acting in.
 * @param {object} params.actor Authenticated account making the request.
 * @returns {Promise<Array<object>>} Decrypted credentials, highest priority first.
 */
async function loadDecryptedKeys({ namespace, actor }) {
  const organizationKeys =
    namespace.type === 'ORG' ? await loadForAccount(namespace.id, 'ORG') : [];

  // A personal namespace is only ever reachable by the account that owns it, so
  // this is the caller's own chain in both cases: either the whole chain, or
  // the tail of it behind the organization's.
  const personalKeys = await loadForAccount(actor.id, 'USER');

  const keys = [...organizationKeys, ...personalKeys];

  if (keys.length === 0 && config.ai.allowDefaultApiKey && config.ai.defaultApiKey) {
    keys.push({
      id: null,
      accountId: null,
      origin: 'BUILT_IN',
      provider: config.ai.defaultProvider,
      chatModel: config.ai.defaultModel,
      apiKey: config.ai.defaultApiKey,
      label: 'Built in development key',
      lastFour: null,
    });
  }

  return keys;
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
  loadDecryptedKeys,
  recordKeyAttempts,
  resolveProviderModel,
  MAX_KEYS_PER_ACCOUNT,
};
