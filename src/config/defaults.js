'use strict';

/**
 * Built in development defaults.
 *
 * The project requirement is that the server boots and is fully testable with
 * no configuration at all. These constants make that possible.
 *
 * SECURITY CONTRACT: every value here is a publicly known placeholder. None of
 * them is ever used when `PROD=true` — `src/config/index.js` hard fails at boot
 * if a production run would rely on one. They exist so that a developer or CI
 * job can clone the repository and run `npm test` immediately.
 */

/** Marker embedded in every development default so leaks are greppable. */
const DEVELOPMENT_MARKER = 'lxtranslator_development_';

module.exports = {
  DEVELOPMENT_MARKER,

  /** Signing secret for access tokens when PROD is disabled. */
  JWT_SECRET: `${DEVELOPMENT_MARKER}jwt_secret_not_for_production_use`,

  /** Passphrase used to derive the AES key that wraps project API keys. */
  ENCRYPTION_PASSPHRASE: `${DEVELOPMENT_MARKER}encryption_passphrase_not_for_production_use`,

  /**
   * Default AI credential. The bundled `mock` provider accepts this key, which
   * is what allows the whole translation pipeline to be exercised end to end
   * without anybody supplying a real vendor key.
   */
  AI_API_KEY: `${DEVELOPMENT_MARKER}default_ai_key`,

  /** Provider used when a project does not pick one. Performs no network calls. */
  AI_PROVIDER: 'mock',

  /** Model used when a project does not pick one. */
  AI_MODEL: 'mock-small',

  /** SQLite file used when PROD is disabled and no explicit path is given. */
  SQLITE_STORAGE: './data/lxtranslator.sqlite',
};
