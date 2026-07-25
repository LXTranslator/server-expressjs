'use strict';

const mock = require('./mock');
const openai = require('./openai');
const anthropic = require('./anthropic');

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
 * Lists providers and their models for the settings interface.
 *
 * @returns {Array<object>} Client safe provider catalogue.
 */
function listProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    name: provider.name,
    label: provider.label,
    default_model: provider.defaultModel,
    models: provider.models,
    requires_network: provider.requiresNetwork,
  }));
}

module.exports = { PROVIDERS, getProvider, isKnownProvider, listProviders };
