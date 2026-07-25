'use strict';

const request = require('supertest');
const createApp = require('../../src/app');
const {
  connectDatabase,
  syncDatabase,
  closeDatabase,
} = require('../../src/infrastructure/database/sequelize');
const { translationPool } = require('../../src/workers/pool');

require('../../src/infrastructure/database/models');

/**
 * Shared test harness.
 *
 * Builds the real application against an in memory database. Nothing is stubbed
 * except the AI provider, which defaults to the offline mock, so the tests
 * exercise the same code path production does.
 */

let app = null;

/**
 * Boots the application once per test file.
 *
 * @returns {Promise<import('express').Express>} The application.
 */
async function setupTestApp() {
  if (app === null) {
    await connectDatabase();
    app = createApp();
  }
  await syncDatabase({ force: true });
  return app;
}

/**
 * Releases the database connection and worker threads.
 *
 * @returns {Promise<void>}
 */
async function teardownTestApp() {
  await translationPool.shutdown();
  await closeDatabase();
  app = null;
}

/** Password satisfying the policy, reused across the suite. */
const VALID_PASSWORD = 'Str0ngPassphrase';

/**
 * Registers an account and returns its session token.
 *
 * @param {import('express').Express} application The application.
 * @param {object} [overrides] Field overrides.
 * @returns {Promise<{token: string, account: object}>}
 */
async function registerAccount(application, overrides = {}) {
  const payload = {
    user_id: overrides.user_id ?? `tester_${Math.random().toString(36).slice(2, 10)}`,
    email: overrides.email ?? `${Math.random().toString(36).slice(2, 10)}@example.test`,
    password: overrides.password ?? VALID_PASSWORD,
    confirm_password: overrides.confirm_password ?? overrides.password ?? VALID_PASSWORD,
  };

  const response = await request(application)
    .post('/api/v1/auth/register')
    .send(payload)
    .expect(201);

  return {
    token: response.body.data.access_token,
    account: response.body.data.account,
    password: payload.password,
  };
}

/**
 * Creates a project inside a namespace.
 *
 * @param {import('express').Express} application The application.
 * @param {string} token Session token.
 * @param {string} namespace Namespace routing identifier.
 * @param {object} [overrides] Field overrides.
 * @returns {Promise<object>} The created project.
 */
async function createProject(application, token, namespace, overrides = {}) {
  const response = await request(application)
    .post(`/api/v1/namespaces/${namespace}/projects`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: overrides.name ?? `project_${Math.random().toString(36).slice(2, 8)}`,
      ai_provider: overrides.ai_provider ?? 'mock',
      ai_model: overrides.ai_model ?? 'mock-small',
    })
    .expect(201);

  return response.body.data.project;
}

/**
 * Polls a file until it leaves the processing states.
 *
 * The pipeline runs on a worker thread after the upload responds, so tests wait
 * for a terminal status rather than assuming completion.
 *
 * @param {import('express').Express} application The application.
 * @param {string} token Session token.
 * @param {string} fileId File identifier.
 * @param {number} [timeoutMs] Maximum wait.
 * @returns {Promise<object>} The file record in a terminal state.
 */
async function waitForFile(application, token, fileId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await request(application)
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const file = response.body.data.file;
    if (file.status === 'READY' || file.status === 'FAILED') return file;

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error(`File ${fileId} did not finish processing within ${timeoutMs}ms.`);
}

module.exports = {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
  VALID_PASSWORD,
};
