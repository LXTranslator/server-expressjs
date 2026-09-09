'use strict';

// `quiet` suppresses the startup banner so structured JSON stays the only
// thing on stdout, which keeps log shipping and test output clean.
require('dotenv').config({ quiet: true });

const path = require('node:path');
const { readString, readBoolean, readInteger, readList, requireString } = require('./env');
const defaults = require('./defaults');

/**
 * The single production switch for the whole server.
 *
 * PROD=true  -> PostgreSQL, no built in secrets, hardened defaults.
 * PROD=false -> SQLite, built in development secrets, relaxed defaults.
 * PROD unset -> treated exactly like PROD=false.
 */
const isProduction = readBoolean('PROD', false);

/** Test runs pin themselves to an isolated in memory database. */
const isTest = readString('NODE_ENV') === 'test';

/**
 * Resolves database settings from the PROD switch.
 *
 * PostgreSQL is only ever selected in production, and it deliberately has no
 * default host or credentials so a misconfigured deployment fails at boot
 * instead of silently writing to the wrong place.
 *
 * @returns {object} Database configuration block.
 */
function resolveDatabase() {
  if (isProduction) {
    return {
      dialect: 'postgres',
      host: requireString('PG_HOST'),
      port: readInteger('PG_PORT', 5432, { min: 1, max: 65535 }),
      database: requireString('PG_DATABASE'),
      username: requireString('PG_USER'),
      password: requireString('PG_PASSWORD'),
      ssl: readBoolean('PG_SSL', true),
      poolMax: readInteger('PG_POOL_MAX', 10, { min: 1, max: 100 }),
      poolMin: readInteger('PG_POOL_MIN', 0, { min: 0, max: 50 }),
      poolIdleMillis: readInteger('PG_POOL_IDLE', 10000, { min: 1000 }),
      storage: null,
    };
  }

  return {
    dialect: 'sqlite',
    storage: isTest ? ':memory:' : readString('SQLITE_STORAGE', defaults.SQLITE_STORAGE),
    host: null,
    port: null,
    database: null,
    username: null,
    password: null,
    ssl: false,
    poolMax: 5,
    poolMin: 0,
    poolIdleMillis: 10000,
  };
}

/**
 * Resolves the token signing secret.
 *
 * @returns {string} Secret used to sign and verify every JWT.
 */
function resolveJwtSecret() {
  if (isProduction) {
    const secret = requireString('JWT_SECRET');
    if (secret.includes(defaults.DEVELOPMENT_MARKER)) {
      throw new Error('JWT_SECRET is set to a development placeholder while PROD is enabled.');
    }
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters when PROD is enabled.');
    }
    return secret;
  }
  return readString('JWT_SECRET', defaults.JWT_SECRET);
}

/**
 * Resolves the passphrase that derives the AES key wrapping project API keys.
 *
 * @returns {string} Encryption passphrase.
 */
function resolveEncryptionPassphrase() {
  if (isProduction) {
    const passphrase = requireString('ENCRYPTION_PASSPHRASE');
    if (passphrase.includes(defaults.DEVELOPMENT_MARKER)) {
      throw new Error(
        'ENCRYPTION_PASSPHRASE is set to a development placeholder while PROD is enabled.',
      );
    }
    if (passphrase.length < 32) {
      throw new Error('ENCRYPTION_PASSPHRASE must be at least 32 characters when PROD is enabled.');
    }
    return passphrase;
  }
  return readString('ENCRYPTION_PASSPHRASE', defaults.ENCRYPTION_PASSPHRASE);
}

const storageRoot = path.resolve(readString('UPLOAD_STORAGE_DIR', './storage/uploads'));

/**
 * Reads the authenticator issuer label, refusing a value that would break the URI.
 *
 * A colon separates the two halves of an `otpauth://` label, so one inside the
 * issuer splits the label in the wrong place and the authenticator shows a
 * mangled name. Rejecting it at boot beats discovering it on somebody's phone.
 *
 * @returns {string} The issuer label.
 * @throws {Error} When the configured value cannot be used in a label.
 */
function resolveIssuerName() {
  const name = readString('AUTHENTICATION_NAME', 'LXTranslator');

  if (name.includes(':')) {
    throw new Error('AUTHENTICATION_NAME must not contain a colon; it separates the label halves.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('AUTHENTICATION_NAME must not contain control characters.');
  }
  if (name.length > 40) {
    throw new Error('AUTHENTICATION_NAME must be 40 characters or fewer.');
  }

  return name;
}

/**
 * Reads one provider's credential pair.
 *
 * Half a pair is a mistake rather than a decision: it looks configured, offers
 * the button, and fails at the token exchange. In production that is refused at
 * boot, where it is cheap to notice.
 *
 * @param {string} prefix Environment variable prefix, such as `GITHUB`.
 * @returns {{clientId: string|undefined, clientSecret: string|undefined}} The pair.
 * @throws {Error} When exactly one half is set while PROD is enabled.
 */
function resolveOauthCredentials(prefix) {
  const clientId = readString(`${prefix}_OAUTH_CLIENT_ID`);
  const clientSecret = readString(`${prefix}_OAUTH_CLIENT_SECRET`);

  if (isProduction && Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${prefix}_OAUTH_CLIENT_ID and ${prefix}_OAUTH_CLIENT_SECRET must be set together.`,
    );
  }

  return { clientId, clientSecret };
}

const config = Object.freeze({
  isProduction,
  isTest,

  app: Object.freeze({
    name: 'LXTranslator Server',
    port: readInteger('PORT', 4000, { min: 1, max: 65535 }),
    host: readString('HOST', '0.0.0.0'),
    /** Public URL of the React client, used to build password reset links. */
    clientUrl: readString('CLIENT_URL', 'http://localhost:5173'),
    trustProxy: readBoolean('TRUST_PROXY', isProduction),
    logLevel: readString('LOG_LEVEL', isTest ? 'silent' : 'info'),
  }),

  database: Object.freeze(resolveDatabase()),

  security: Object.freeze({
    jwtSecret: resolveJwtSecret(),
    jwtIssuer: readString('JWT_ISSUER', 'lxtranslator'),
    jwtAudience: readString('JWT_AUDIENCE', 'lxtranslator_client'),
    /** Lifetime of a normal session token. */
    accessTokenTtlSeconds: readInteger('ACCESS_TOKEN_TTL_SECONDS', 3600, { min: 60, max: 86400 }),
    /**
     * Lifetime of password reset and settings update tokens. The specification
     * fixes this at exactly ten minutes, so it is a constant rather than a
     * tunable value.
     */
    shortLivedTokenTtlSeconds: 600,
    encryptionPassphrase: resolveEncryptionPassphrase(),
    bcryptRounds: readInteger('BCRYPT_ROUNDS', isTest ? 4 : 12, { min: 4, max: 15 }),
    maxFailedLogins: readInteger('MAX_FAILED_LOGINS', 5, { min: 3, max: 20 }),
    lockoutMinutes: readInteger('LOCKOUT_MINUTES', 15, { min: 1, max: 1440 }),
    corsOrigins: readList('CORS_ORIGINS', ['http://localhost:5173', 'http://localhost:3000']),
  }),

  /**
   * Provider sign in credentials.
   *
   * Only the client identifier and secret are configurable. Every endpoint an
   * adapter reaches is a constant inside it, because a configurable base URL
   * turns a sign in into an arbitrary outbound request.
   *
   * `readString` with no fallback yields undefined, so a provider with neither
   * half set is simply absent. Nothing here is required, and a deployment that
   * configures none of them behaves exactly as it did before.
   */
  oauth: Object.freeze({
    github: Object.freeze(resolveOauthCredentials('GITHUB')),
    gitlab: Object.freeze(resolveOauthCredentials('GITLAB')),
    mock: Object.freeze(resolveOauthCredentials('MOCK')),
  }),

  mfa: Object.freeze({
    /**
     * Label an authenticator app shows above the code.
     *
     * It is the issuer half of the `otpauth://` label, which is what somebody
     * reads when they have six accounts in the app and need to know which one
     * this is. A default is supplied so nothing has to be configured.
     */
    issuerName: resolveIssuerName(),
  }),

  rateLimit: Object.freeze({
    windowMs: readInteger('RATE_LIMIT_WINDOW_MS', 60000, { min: 1000 }),
    globalMax: readInteger('RATE_LIMIT_GLOBAL_MAX', 300, { min: 10 }),
    authMax: readInteger('RATE_LIMIT_AUTH_MAX', 10, { min: 3 }),
    availabilityMax: readInteger('RATE_LIMIT_AVAILABILITY_MAX', 20, { min: 5 }),
    uploadMax: readInteger('RATE_LIMIT_UPLOAD_MAX', 20, { min: 1 }),
    /** Each chat turn is several paid model calls, so it gets its own bucket. */
    chatMax: readInteger('RATE_LIMIT_CHAT_MAX', 30, { min: 1 }),
    /** Disabled under test so the suite is not throttled by its own speed. */
    enabled: readBoolean('RATE_LIMIT_ENABLED', !isTest),
  }),

  upload: Object.freeze({
    storageDir: storageRoot,
    maxBytes: readInteger('UPLOAD_MAX_BYTES', 2 * 1024 * 1024, { min: 1024 }),
    maxFiles: 1,
    maxFilenameLength: 128,
    allowedExtensions: Object.freeze(['.json']),
    allowedMimeTypes: Object.freeze(['application/json', 'text/json', 'application/octet-stream']),
    /** Guards against deeply nested payloads designed to exhaust the parser. */
    maxJsonDepth: readInteger('UPLOAD_MAX_JSON_DEPTH', 20, { min: 1, max: 100 }),
    maxTranslationKeys: readInteger('UPLOAD_MAX_KEYS', 5000, { min: 1 }),
  }),

  ai: Object.freeze({
    defaultProvider: readString('AI_DEFAULT_PROVIDER', defaults.AI_PROVIDER),
    defaultModel: readString('AI_DEFAULT_MODEL', defaults.AI_MODEL),
    /**
     * Built in credential so the pipeline is runnable with no configuration.
     * Refused outright in production.
     */
    defaultApiKey: isProduction ? null : readString('AI_DEFAULT_API_KEY', defaults.AI_API_KEY),
    allowDefaultApiKey: !isProduction,
    requestTimeoutMs: readInteger('AI_REQUEST_TIMEOUT_MS', 30000, { min: 1000 }),
    maxAttemptsPerKey: readInteger('AI_MAX_ATTEMPTS_PER_KEY', 2, { min: 1, max: 5 }),
    batchSize: readInteger('AI_BATCH_SIZE', 25, { min: 1, max: 200 }),
  }),

  chat: Object.freeze({
    /**
     * How many times the assistant may decide, act and look again within one
     * request. Every pass is a paid model call, so the loop is bounded by
     * configuration rather than by the model choosing to stop.
     */
    maxRepeats: readInteger('AGENTS_CHAT_REPEAT', 5, { min: 1, max: 20 }),
    /** Past exchanges replayed as context, which is what bounds the prompt. */
    historyTurns: readInteger('AGENTS_CHAT_HISTORY_TURNS', 10, { min: 0, max: 100 }),
    maxPromptCharacters: readInteger('AGENTS_CHAT_MAX_PROMPT', 8000, { min: 100 }),
    /**
     * Chat logs held in memory while the database is unavailable. Bounded
     * because a buffer that grows without limit turns a database outage into a
     * memory exhaustion.
     */
    logBufferSize: readInteger('AGENTS_CHAT_LOG_BUFFER', 500, { min: 1 }),
    logRetryMs: readInteger('AGENTS_CHAT_LOG_RETRY_MS', 5000, { min: 100 }),
    /** Rows one backfill request may embed, so the call stays bounded. */
    embeddingBackfillLimit: readInteger('AGENTS_CHAT_EMBED_BATCH', 50, { min: 1, max: 500 }),
  }),

  usage: Object.freeze({
    /**
     * Whether authenticated requests are recorded at all.
     *
     * On by default, because the point of the record is to be there when
     * somebody asks what happened, and one turned on afterwards answers
     * nothing about the past.
     */
    enabled: readBoolean('API_USAGE_LOG', true),
    /**
     * How long entries are kept.
     *
     * Configuration rather than a constant: how long this has to be kept is a
     * question about somebody's obligations, not about the code.
     */
    retentionDays: readInteger('API_USAGE_RETENTION_DAYS', 90, { min: 1, max: 3650 }),
  }),

  workers: Object.freeze({
    poolSize: readInteger('WORKER_POOL_SIZE', isTest ? 1 : 2, { min: 1, max: 16 }),
    taskTimeoutMs: readInteger('WORKER_TASK_TIMEOUT_MS', 300000, { min: 1000 }),
  }),

  mail: Object.freeze({
    /**
     * `console` writes the message to the log instead of sending it, which is
     * what keeps the forgot password flow testable without an SMTP server.
     */
    transport: readString('MAIL_TRANSPORT', isProduction ? 'smtp' : 'console'),
    from: readString('MAIL_FROM', 'LXTranslator <no_reply@lxtranslator.local>'),
    smtpHost: readString('SMTP_HOST'),
    smtpPort: readInteger('SMTP_PORT', 587, { min: 1, max: 65535 }),
    smtpSecure: readBoolean('SMTP_SECURE', false),
    smtpUser: readString('SMTP_USER'),
    smtpPassword: readString('SMTP_PASSWORD'),
  }),
});

module.exports = config;
