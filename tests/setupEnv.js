'use strict';

/**
 * Test environment.
 *
 * Pinned before any module loads so the configuration layer resolves to an
 * isolated in memory database with the built in development secrets. This is
 * what lets `npm test` run on a clean clone with no configuration at all.
 */

process.env.NODE_ENV = 'test';

// PROD is explicitly false: production selects PostgreSQL and refuses the
// built in secrets, neither of which suits a test run.
process.env.PROD = 'false';

process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MAIL_TRANSPORT = 'console';

// The lowest bcrypt cost the library accepts, so the suite is not dominated by
// key derivation. Production uses the configured default of 12.
process.env.BCRYPT_ROUNDS = '4';

process.env.WORKER_POOL_SIZE = '1';
process.env.UPLOAD_STORAGE_DIR = './tmp/test_storage';

/*
 * The offline provider, enabled the same way a real one would be.
 *
 * `github` and `gitlab` are deliberately left unconfigured, so the suite proves
 * two things at once: that the whole provider round trip works through the real
 * routes, and that an unconfigured provider is genuinely absent rather than
 * merely untested. The mock reaches no network and is never registered when
 * PROD is true.
 */
process.env.MOCK_OAUTH_CLIENT_ID = 'mock_client_id';
process.env.MOCK_OAUTH_CLIENT_SECRET = 'mock_client_secret';
