'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
} = require('./helpers/testApp');

/*
 * Project identity.
 *
 * Two rules meet here and are easy to break together: a project name belongs to
 * its namespace, while a project identifier belongs to the whole table. The
 * tests below pin both, in the one arrangement that distinguishes them, a user
 * namespace and an organization namespace holding the same project name.
 */
describe('project identity', () => {
  let app;
  let owner;
  let outsider;

  beforeAll(async () => {
    app = await setupTestApp();

    owner = await registerAccount(app, {
      user_id: 'project_owner',
      email: 'project_owner@example.test',
    });
    outsider = await registerAccount(app, {
      user_id: 'project_outsider',
      email: 'project_outsider@example.test',
    });

    await request(app)
      .post('/api/v1/namespaces/organizations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ user_id: 'project_org', email: 'project_org@example.test' })
      .expect(201);
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  describe('names are scoped to their namespace', () => {
    it('accepts the same name in a personal and an organization namespace', async () => {
      const personal = await createProject(app, owner.token, 'project_owner', {
        name: 'website',
      });
      const organization = await createProject(app, owner.token, 'project_org', {
        name: 'website',
      });

      expect(personal.name).toBe('website');
      expect(organization.name).toBe('website');
      expect(personal.namespace_account_id).not.toBe(organization.namespace_account_id);
    });

    it('accepts the same name in a namespace belonging to someone else', async () => {
      const other = await createProject(app, outsider.token, 'project_outsider', {
        name: 'website',
      });

      expect(other.name).toBe('website');
    });

    it('refuses a duplicate name inside one namespace', async () => {
      await request(app)
        .post('/api/v1/namespaces/project_owner/projects')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: 'website', ai_provider: 'mock', ai_model: 'mock-small' })
        .expect(409);
    });
  });

  describe('identifiers come from one shared sequence', () => {
    it('numbers projects across namespaces from the same table', async () => {
      const first = await createProject(app, owner.token, 'project_owner', {
        name: 'sequence_one',
      });
      const second = await createProject(app, owner.token, 'project_org', {
        name: 'sequence_two',
      });

      // Different namespaces, yet the identifiers are drawn from one counter,
      // which is what makes a project identifier unique on its own.
      expect(Number.isInteger(first.id)).toBe(true);
      expect(Number.isInteger(second.id)).toBe(true);
      expect(second.id).toBeGreaterThan(first.id);
    });

    it('addresses a project by its identifier alone', async () => {
      const project = await createProject(app, owner.token, 'project_owner', {
        name: 'addressable',
      });

      const response = await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(response.body.data.project.id).toBe(project.id);
    });
  });

  describe('malformed identifiers', () => {
    /*
     * An integer column cannot be compared against arbitrary text. PostgreSQL
     * raises a type error where SQLite quietly matches nothing, so without a
     * guard the same request is a 500 in production and a 404 in the test
     * suite. Each case below must be a 404.
     */
    it.each([
      ['text', 'not_a_number'],
      ['a decimal', '1.5'],
      ['a negative number', '-1'],
      ['zero', '0'],
      ['a leading zero', '01'],
      ['a UUID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
      ['an injection attempt', '1%20OR%201=1'],
    ])('returns 404 for %s', async (_label, identifier) => {
      await request(app)
        .get(`/api/v1/projects/${identifier}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(404);
    });
  });

  describe('object level authorization', () => {
    it('still hides a project whose identifier is guessed', async () => {
      const project = await createProject(app, owner.token, 'project_owner', {
        name: 'guessable',
      });

      // Sequential identifiers are trivially enumerable, so this is the case
      // that matters: knowing the number must not be worth anything.
      await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });
  });
});
