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

  describe('the platform a new project starts on', () => {
    /*
     * The default platform is not a cosmetic choice.
     *
     * The configured default is the offline mock, which hands back the English
     * text with a locale marker in front of it and still reports the file as
     * finished. An account that has added a real credential and then creates a
     * project must not get that: the credential is the clearest statement there
     * is about which platform this account translates on.
     *
     * These post directly rather than through the `createProject` helper, which
     * always names a platform and so can never exercise the default.
     */

    /**
     * Registers an account with one active credential.
     *
     * @param {string} handle Account identifier.
     * @param {string} provider Platform the credential is for.
     * @returns {Promise<object>} The registration.
     */
    async function accountWithKey(handle, provider) {
      const registered = await registerAccount(app, {
        user_id: handle,
        email: `${handle}@example.test`,
      });

      await request(app)
        .post(`/api/v1/namespaces/${registered.account.user_id}/settings/ai_keys`)
        .set('Authorization', `Bearer ${registered.token}`)
        .send({ provider, api_key: `${provider}_key_for_${handle}_1234` })
        .expect(201);

      return registered;
    }

    /**
     * Creates a project naming only what the caller passes.
     *
     * @param {string} token Session token.
     * @param {string} namespace Namespace handle.
     * @param {object} body Payload.
     * @returns {Promise<object>} The created project.
     */
    async function create(token, namespace, body) {
      const response = await request(app)
        .post(`/api/v1/namespaces/${namespace}/projects`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      return response.body.data.project;
    }

    it('follows the credential the account actually holds', async () => {
      const registered = await accountWithKey('platform_default_user', 'openrouter');

      const project = await create(registered.token, registered.account.user_id, {
        name: 'inherits_platform',
      });

      expect(project.ai_provider).toBe('openrouter');
      expect(project.ai_model).toBe('openai/gpt-4o-mini');
    });

    it('still lets the caller name a platform explicitly', async () => {
      const registered = await accountWithKey('platform_explicit_user', 'openrouter');

      const project = await create(registered.token, registered.account.user_id, {
        name: 'explicit_platform',
        ai_provider: 'anthropic',
      });

      expect(project.ai_provider).toBe('anthropic');
    });

    it('falls back to the configured default when the account has no credential', async () => {
      // The zero configuration promise: a clean clone with nothing set up still
      // creates projects that translate, offline and for free.
      const registered = await registerAccount(app, {
        user_id: 'platform_bare_user',
        email: 'platform_bare_user@example.test',
      });

      const project = await create(registered.token, registered.account.user_id, {
        name: 'bare_account',
      });

      expect(project.ai_provider).toBe('mock');
    });

    it('ignores a credential that has been disabled', async () => {
      const registered = await accountWithKey('platform_disabled_user', 'openrouter');

      const listed = await request(app)
        .get(`/api/v1/namespaces/${registered.account.user_id}/settings/ai_keys`)
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      await request(app)
        .patch(
          `/api/v1/namespaces/${registered.account.user_id}/settings/ai_keys/${listed.body.data.keys[0].id}`,
        )
        .set('Authorization', `Bearer ${registered.token}`)
        .send({ is_active: false })
        .expect(200);

      const project = await create(registered.token, registered.account.user_id, {
        name: 'disabled_credential',
      });

      expect(project.ai_provider).toBe('mock');
    });

    it('prefers the organization credential over the member own', async () => {
      // The chain is walked organization first, so a project created inside one
      // defaults to what the organization pays for.
      const member = await accountWithKey('platform_org_member', 'anthropic');

      const organization = await request(app)
        .post('/api/v1/namespaces/organizations')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ user_id: 'platform_org', email: 'platform_org@example.test' })
        .expect(201);

      const handle = organization.body.data.namespace.user_id;

      await request(app)
        .post(`/api/v1/namespaces/${handle}/settings/ai_keys`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ provider: 'openrouter', api_key: 'org_openrouter_key_5678' })
        .expect(201);

      const project = await create(member.token, handle, { name: 'org_platform' });

      expect(project.ai_provider).toBe('openrouter');
    });

    it('uses the member own credential when the organization has none', async () => {
      const member = await accountWithKey('platform_solo_member', 'anthropic');

      const organization = await request(app)
        .post('/api/v1/namespaces/organizations')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ user_id: 'platform_org_bare', email: 'platform_org_bare@example.test' })
        .expect(201);

      const project = await create(
        member.token,
        organization.body.data.namespace.user_id,
        { name: 'member_platform' },
      );

      expect(project.ai_provider).toBe('anthropic');
    });
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
