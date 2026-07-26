'use strict';

const mock = require('./mock');
const openai = require('./openai');
const anthropic = require('./anthropic');
const openrouter = require('./openrouter');

/**
 * Fixed provider registry.
 *
 * Lookups go through {@link getProvider}, which only ever returns an entry from
 * this object. A project stores a provider *name*, so a tampered database row
 * can select a different adapter but can never introduce a new endpoint.
 */
const PROVIDERS = Object.freeze({
  [mock.name]: mock,
  [openai.name]: openai,
  [anthropic.name]: anthropic,
  [openrouter.name]: openrouter,
});

/**
 * Resolves a provider adapter by name.
 *
 * @param {string} name Provider identifier.
 * @returns {object|null} The adapter, or null when the name is unknown.
 */
function getProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
}

/**
 * Reports whether a provider name is valid.
 *
 * @param {string} name Provider identifier.
 * @returns {boolean}
 */
function isKnownProvider(name) {
  return getProvider(name) !== null;
}

/**
 * Reports whether a provider offers an embedding model by that name.
 *
 * An empty list is a legitimate answer rather than an oversight: Anthropic
 * serves no embeddings endpoint, so nothing it could be asked for exists.
 *
 * @param {string} name Provider identifier.
 * @param {string} model Embedding model identifier.
 * @returns {boolean}
 */
function isKnownEmbeddingModel(name, model) {
  const provider = getProvider(name);
  return provider !== null && (provider.embeddingModels ?? []).includes(model);
}

/**
 * Lists providers and their models for the settings interface.
 *
 * Chat models and embedding models are listed separately because an account
 * configures both, and because a platform may offer one and not the other.
 *
 * @returns {Array<object>} Client safe provider catalogue.
 */
function listProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    name: provider.name,
    label: provider.label,
    default_model: provider.defaultModel,
    models: provider.models,
    embedding_models: provider.embeddingModels ?? [],
    default_embedding_model: provider.defaultEmbeddingModel ?? null,
    supports_caching: provider.supportsCaching === true,
    requires_network: provider.requiresNetwork,
  }));
}

module.exports = {
  PROVIDERS,
  getProvider,
  isKnownProvider,
  isKnownEmbeddingModel,
  listProviders,
};
