import config from '../../../config';
import github from './github';
import gitlab from './gitlab';
import mock from './mock';
import type { OauthProvider } from '../types';

/**
 * Fixed provider registry.
 *
 * The same shape as the AI registry, for the same reason: a lookup only ever
 * returns an entry from this object, so a tampered database row can select a
 * different adapter but can never introduce a new endpoint. Every URL an
 * adapter reaches is a constant inside it.
 *
 * The mock is registered only outside production. It answers without touching
 * the network, which is what keeps the suite runnable on a clean clone with no
 * configuration, and it must never be reachable on a real deployment.
 */
const PROVIDERS: Readonly<Record<string, OauthProvider>> = Object.freeze({
  [github.name]: github,
  [gitlab.name]: gitlab,
  ...(config.isProduction ? {} : { [mock.name]: mock }),
});

/**
 * Resolves an adapter by name.
 *
 * @param {string} name Provider identifier.
 * @returns {object|null} The adapter, or null when the name is unknown.
 */
function getProvider(name: string): OauthProvider | null {
  if (typeof name !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
}

/**
 * Reports whether a provider name is one this application knows.
 *
 * @param {string} name Provider identifier.
 * @returns {boolean} True when the adapter exists.
 */
function isKnownProvider(name: string): boolean {
  return getProvider(name) !== null;
}

/**
 * Reports whether a provider has both halves of its credential configured.
 *
 * One half without the other is a misconfiguration rather than a choice, and
 * it is refused at boot in production. Here it simply means not enabled.
 *
 * @param {string} name Provider identifier.
 * @returns {boolean} True when the provider can actually be used.
 */
function isEnabled(name: string): boolean {
  const credentials = (config.oauth as Readonly<Record<string, { clientId?: string; clientSecret?: string }>>)[name];
  if (credentials === undefined) return false;
  return Boolean(credentials.clientId) && Boolean(credentials.clientSecret);
}

/**
 * Lists the providers a visitor may actually sign in with.
 *
 * An empty list is the ordinary state of a deployment that configured none of
 * them, and the client renders nothing rather than a button that cannot work.
 *
 * @returns {Array<{name: string, label: string}>} Enabled providers.
 */
function listEnabled(): Array<{ name: string; label: string; }> {
  return Object.values(PROVIDERS)
    .filter((provider) => isEnabled(provider.name))
    .map((provider) => ({ name: provider.name, label: provider.label }));
}

export { getProvider, isKnownProvider, isEnabled, listEnabled, PROVIDERS };
