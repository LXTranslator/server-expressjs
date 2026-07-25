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
