import request from 'supertest';
import type { Express } from 'express';
import createApp from '../../src/app';
import {
  connectDatabase,
  syncDatabase,
  closeDatabase,
} from '../../src/infrastructure/database/sequelize';
import { translationPool } from '../../src/workers/pool';

import '../../src/infrastructure/database/models';

/**
 * A JSON body as the API sends it.
 *
 * Tests read responses the way a client does, field by field, and assert on
 * what they find. Typing every payload the API can return would restate the
 * serializers here, so a body is a loose record, exactly as supertest hands it
 * over.
 */
type ApiJson = Record<string, any>;

/** Fields a test may override when registering an account. */
interface AccountOverrides {
  user_id?: string;
  email?: string;
  password?: string;
  confirm_password?: string;
}

/** Fields a test may override when creating a project. */
interface ProjectOverrides {
  name?: string;
  ai_provider?: string;
  ai_model?: string;
}

/** A registered account and the credentials that reach it. */
interface RegisteredAccount {
  token: string;
  account: ApiJson;
  password: string;
}

/**
 * Shared test harness.
 *
 * Builds the real application against an in memory database. Nothing is stubbed
 * except the AI provider, which defaults to the offline mock, so the tests
 * exercise the same code path production does.
 */

let app: Express | null = null;

/**
 * Boots the application once per test file.
 *
 * @returns {Promise<import('express').Express>} The application.
 */
async function setupTestApp(): Promise<Express> {
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
async function teardownTestApp(): Promise<void> {
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
async function registerAccount(application: Express, overrides: AccountOverrides = {}): Promise<RegisteredAccount> {
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
async function createProject(application: Express, token: string, namespace: string, overrides: ProjectOverrides = {}): Promise<ApiJson> {
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
async function waitForFile(application: Express, token: string, fileId: string, timeoutMs: number = 15000): Promise<ApiJson> {
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

export type { ApiJson, AccountOverrides, ProjectOverrides, RegisteredAccount };
export {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
  VALID_PASSWORD,
};
