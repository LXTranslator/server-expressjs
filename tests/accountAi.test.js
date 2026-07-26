'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
} = require('./helpers/testApp');
const {
  Account,
  AccountApiKey,
  AiChatLog,
} = require('../src/infrastructure/database/models');
const accountKeyService = require('../src/modules/accountKeys/accountKey.service');
const { runWithKeyFallback } = require('../src/infrastructure/ai/keyFallback');
const { ProviderError, PROVIDER_ERROR_KINDS } = require('../src/infrastructure/ai/providerError');

/*
 * Account level AI configuration.
 *
 * Two properties matter more than the CRUD around them. An organization's
 * credential must be tried before the member's own, and must fall through to it
 * rather than failing the request; and a stored credential must never come back
 * out, at any role, through any endpoint.
 */

describe('account AI configuration', () => {
  let app;
  let ownerToken;
  let ownerAccount;
  let memberToken;
  let memberAccount;
  let outsiderToken;
  let orgId;
  let orgAccount;

  beforeAll(async () => {
    app = await setupTestApp();

    const owner = await registerAccount(app, {
      user_id: 'ai_owner',
      email: 'ai_owner@example.test',
    });
    ownerToken = owner.token;
    ownerAccount = owner.account;

    const member = await registerAccount(app, {
      user_id: 'ai_member',
      email: 'ai_member@example.test',
    });
    memberToken = member.token;
    memberAccount = member.account;

    const outsider = await registerAccount(app, {
      user_id: 'ai_outsider',
      email: 'ai_outsider@example.test',
    });
    outsiderToken = outsider.token;

    const organization = await request(app)
      .post('/api/v1/namespaces/organizations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ user_id: 'ai_org', email: 'ai_org@example.test' })
      .expect(201);
    orgId = organization.body.data.namespace.user_id;
    orgAccount = organization.body.data.namespace;

    await request(app)
      .post(`/api/v1/namespaces/${orgId}/settings/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ identifier: 'ai_member', role: 'MEMBER' })
      .expect(201);
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  describe('managing credentials', () => {
    it('stores a credential and returns only a mask', async () => {
      const response = await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          provider: 'mock',
          chat_model: 'mock-large',
          api_key: 'org_secret_key_1234',
          label: 'organization primary',
        })
        .expect(201);

      const key = response.body.data.key;
      expect(key.masked_key).toBe('****1234');
      expect(key.provider).toBe('mock');
      expect(key.chat_model).toBe('mock-large');
      expect(JSON.stringify(response.body)).not.toContain('org_secret_key_1234');
    });

    it('stores the credential as ciphertext, not as text', async () => {
      const stored = await AccountApiKey.scope('withSecret').findOne({
        where: { accountId: orgAccount.id },
      });

      expect(stored.apiKey).not.toContain('org_secret_key_1234');
      expect(stored.apiKey.startsWith('v1:')).toBe(true);
    });

    it('excludes the secret from a default query', async () => {
      const listed = await AccountApiKey.findOne({ where: { accountId: orgAccount.id } });
      expect(listed.apiKey).toBeUndefined();
    });

    it('never returns the key on the list endpoint either', async () => {
      const response = await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('org_secret_key_1234');
      expect(response.body.data.keys[0].masked_key).toBe('****1234');
    });

    it('defaults the model to the platform default when none is named', async () => {
      const response = await request(app)
        .post(`/api/v1/namespaces/${ownerAccount.user_id}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ provider: 'mock', api_key: 'personal_secret_key_5678' })
        .expect(201);

      expect(response.body.data.key.chat_model).toBe('mock-small');
    });

    it('appends a new credential to the end of the chain', async () => {
      const response = await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ provider: 'mock', api_key: 'org_secondary_key_9999' })
        .expect(201);

      expect(response.body.data.key.priority_order).toBe(2);
    });

    it('reorders the chain in one call', async () => {
      const before = await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const ids = before.body.data.keys.map((key) => key.id);

      const response = await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys/reorder`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ ordered_key_ids: [...ids].reverse() })
        .expect(200);

      expect(response.body.data.keys.map((key) => key.id)).toEqual([...ids].reverse());

      await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys/reorder`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ ordered_key_ids: ids })
        .expect(200);
    });

    it('refuses a platform outside the registry', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ provider: 'not_a_vendor', api_key: 'whatever_key_0000' })
        .expect(400);
    });

    it('refuses a model the platform does not offer', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ provider: 'mock', chat_model: 'gpt-4o', api_key: 'whatever_key_0000' })
        .expect(400);
    });

    it('refuses an undeclared field, so account_id cannot be smuggled in', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          provider: 'mock',
          api_key: 'whatever_key_0000',
          account_id: memberAccount.id,
        })
        .expect(422);
    });
  });

  describe('who may manage them', () => {
    it('refuses a plain member reading the organization list', async () => {
      await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(403);
    });

    it('refuses a plain member adding one', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ provider: 'mock', api_key: 'member_key_1111' })
        .expect(403);
    });

    it('lets an admin manage them', async () => {
      await request(app)
        .patch(`/api/v1/namespaces/${orgId}/settings/members/${await memberMembershipId()}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'ADMIN' })
        .expect(200);

      await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200);

      await request(app)
        .patch(`/api/v1/namespaces/${orgId}/settings/members/${await memberMembershipId()}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'MEMBER' })
        .expect(200);
    });

    it('hides the organization from an account with no membership', async () => {
      await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(404);
    });

    it('refuses editing a credential that belongs to another namespace', async () => {
      const orgKeys = await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      // Named from the owner's own namespace, where the identifier is unknown.
      await request(app)
        .patch(
          `/api/v1/namespaces/${ownerAccount.user_id}/settings/ai_keys/${orgKeys.body.data.keys[0].id}`,
        )
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ label: 'stolen' })
        .expect(404);
    });

    /**
     * Reads the membership row identifier for the test member.
     *
     * @returns {Promise<string>} Membership identifier.
     */
    async function memberMembershipId() {
      const response = await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/members`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      return response.body.data.members.find(
        (entry) => entry.user_account_id === memberAccount.id,
      ).id;
    }
  });

  describe('the organization to personal fallback chain', () => {
    /**
     * Loads the credential chain the way a chat turn would.
     *
     * @param {string} namespaceId Namespace being acted in.
     * @param {string} actorId Account making the request.
     * @returns {Promise<Array<object>>} Decrypted chain.
     */
    async function loadChain(namespaceId, actorId) {
      const namespace = await Account.findByPk(namespaceId);
      const actor = await Account.findByPk(actorId);
      return accountKeyService.loadDecryptedKeys({ namespace, actor });
    }

    beforeAll(async () => {
      // A personal credential for the member, so the organization has something
      // to fall through to.
      await request(app)
        .post(`/api/v1/namespaces/${memberAccount.user_id}/settings/ai_keys`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ provider: 'mock', api_key: 'member_personal_key_2222', label: 'mine' })
        .expect(201);
    });

    it('puts the organization first and the person second', async () => {
      const chain = await loadChain(orgAccount.id, memberAccount.id);

      expect(chain.map((key) => key.origin)).toEqual(['ORG', 'ORG', 'USER']);
      expect(chain[chain.length - 1].lastFour).toBe('2222');
    });

    it('never reaches the personal credential of another member', async () => {
      const chain = await loadChain(orgAccount.id, memberAccount.id);
      const personal = chain.filter((key) => key.origin === 'USER');

      expect(personal).toHaveLength(1);
      expect(personal[0].accountId).toBe(memberAccount.id);
    });

    it('is the caller own chain in their own namespace', async () => {
      const chain = await loadChain(memberAccount.id, memberAccount.id);
      expect(chain.map((key) => key.origin)).toEqual(['USER']);
    });

    it('falls back to the personal credential when the organization key fails', async () => {
      const chain = await loadChain(orgAccount.id, memberAccount.id);
      const tried = [];

      const result = await runWithKeyFallback({
        keys: chain,
        emptyMessage: 'no keys',
        attempt: (key) => {
          tried.push(key.origin);
          // Every organization credential is out of quota; the personal one works.
          if (key.origin === 'ORG') {
            throw new ProviderError(PROVIDER_ERROR_KINDS.QUOTA, 'Out of credit.');
          }
          return Promise.resolve('answered');
        },
      });

      expect(tried).toEqual(['ORG', 'ORG', 'USER']);
      expect(result.value).toBe('answered');
      expect(result.key.origin).toBe('USER');
    });

    it.each([
      ['a revoked key', PROVIDER_ERROR_KINDS.AUTH],
      ['an exhausted quota', PROVIDER_ERROR_KINDS.QUOTA],
      ['a throttled key', PROVIDER_ERROR_KINDS.RATE_LIMIT],
    ])('falls through on %s', async (_label, kind) => {
      const chain = await loadChain(orgAccount.id, memberAccount.id);

      const result = await runWithKeyFallback({
        keys: chain,
        emptyMessage: 'no keys',
        attempt: (key) => {
          if (key.origin === 'ORG') throw new ProviderError(kind, 'Organization key failed.');
          return Promise.resolve('answered');
        },
      });

      expect(result.key.origin).toBe('USER');
    });

    it('does not burn the personal credential on a malformed request', async () => {
      // A REQUEST failure is our defect, so every remaining key would fail the
      // same way. Walking on would spend the person's own money on it.
      const chain = await loadChain(orgAccount.id, memberAccount.id);
      const tried = [];

      await expect(
        runWithKeyFallback({
          keys: chain,
          emptyMessage: 'no keys',
          attempt: (key) => {
            tried.push(key.origin);
            throw new ProviderError(PROVIDER_ERROR_KINDS.REQUEST, 'We built a bad payload.');
          },
        }),
      ).rejects.toThrow(/bad payload/);

      expect(tried).toEqual(['ORG']);
    });

    it('records the failure against the credential that failed', async () => {
      const chain = await loadChain(orgAccount.id, memberAccount.id);

      await accountKeyService.recordKeyAttempts([
        { keyId: chain[0].id, outcome: 'FAILED', kind: 'QUOTA' },
        { keyId: chain[chain.length - 1].id, outcome: 'SUCCESS' },
      ]);

      const failed = await AccountApiKey.findByPk(chain[0].id);
      const used = await AccountApiKey.findByPk(chain[chain.length - 1].id);

      expect(failed.lastErrorReason).toBe('QUOTA');
      expect(used.lastUsedAt).not.toBeNull();
      expect(used.lastErrorReason).toBeNull();
    });

    it('skips an inactive credential', async () => {
      const keys = await request(app)
        .get(`/api/v1/namespaces/${orgId}/settings/ai_keys`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      await request(app)
        .patch(`/api/v1/namespaces/${orgId}/settings/ai_keys/${keys.body.data.keys[0].id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ is_active: false })
        .expect(200);

      const chain = await loadChain(orgAccount.id, memberAccount.id);
      expect(chain.map((key) => key.origin)).toEqual(['ORG', 'USER']);

      await request(app)
        .patch(`/api/v1/namespaces/${orgId}/settings/ai_keys/${keys.body.data.keys[0].id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ is_active: true })
        .expect(200);
    });

    it('offers the built in development credential when nothing is configured', async () => {
      // The zero configuration promise: the assistant has to work on a clean
      // clone with no vendor key anywhere.
      const chain = await loadChain(ownerAccount.id, ownerAccount.id);
      const bare = await Account.findByPk(ownerAccount.id);
      await AccountApiKey.destroy({ where: { accountId: bare.id } });

      const empty = await loadChain(ownerAccount.id, ownerAccount.id);
      expect(chain.length).toBeGreaterThan(0);
      expect(empty).toHaveLength(1);
      expect(empty[0].origin).toBe('BUILT_IN');
      expect(empty[0].provider).toBe('mock');
    });
  });

  describe('the platform a project asked for', () => {
    /*
     * A project names a platform and a model and nothing else. The credential
     * comes from the account chain, narrowed to that platform, because an
     * OpenAI key cannot pay for an Anthropic call however high it sits in the
     * order.
     */
    let platformAccount;
    let platformToken;

    beforeAll(async () => {
      const registered = await registerAccount(app, {
        user_id: 'platform_user',
        email: 'platform@example.test',
      });
      platformToken = registered.token;
      platformAccount = registered.account;

      for (const [provider, apiKey] of [
        ['openai', 'openai_account_key_1111'],
        ['mock', 'mock_account_key_2222'],
      ]) {
        await request(app)
          .post(`/api/v1/namespaces/${platformAccount.user_id}/settings/ai_keys`)
          .set('Authorization', `Bearer ${platformToken}`)
          .send({ provider, api_key: apiKey })
          .expect(201);
      }
    });

    /**
     * Loads the chain for the platform account, optionally narrowed.
     *
     * @param {string} [provider] Platform to narrow to.
     * @returns {Promise<Array<object>>} Decrypted chain.
     */
    async function chainFor(provider) {
      const account = await Account.findByPk(platformAccount.id);
      return accountKeyService.loadDecryptedKeys({
        namespace: account,
        actor: account,
        provider,
      });
    }

    it('returns the whole chain when no platform is named', async () => {
      const chain = await chainFor();
      expect(chain.map((key) => key.provider)).toEqual(['openai', 'mock']);
    });

    it('returns only the credentials for the platform that was named', async () => {
      const chain = await chainFor('mock');
      expect(chain.map((key) => key.lastFour)).toEqual(['2222']);
    });

    it('falls back to the built in credential when the platform has none', async () => {
      // Narrowing to a platform the account never configured is the same
      // situation as an account with no credentials at all.
      const chain = await chainFor('anthropic');
      expect(chain).toHaveLength(1);
      expect(chain[0].origin).toBe('BUILT_IN');
      expect(chain[0].provider).toBe('anthropic');
    });

    it('translates a project on the account credential, with none of its own', async () => {
      const project = await createProject(
        app,
        platformToken,
        platformAccount.user_id,
        { name: 'platform_project', ai_provider: 'mock' },
      );

      const uploaded = await request(app)
        .post(`/api/v1/projects/${project.id}/files`)
        .set('Authorization', `Bearer ${platformToken}`)
        .field('target_langs', 'th_th')
        .attach('file', Buffer.from(JSON.stringify({ a: 'A' })), 'en_us.json')
        .expect(202);

      const file = await waitForFile(app, platformToken, uploaded.body.data.file.id);
      expect(file.status).toBe('READY');
    });

    it('has no credential endpoints of its own', async () => {
      const project = await createProject(
        app,
        platformToken,
        platformAccount.user_id,
        { name: 'no_keys_project' },
      );

      await request(app)
        .get(`/api/v1/projects/${project.id}/keys`)
        .set('Authorization', `Bearer ${platformToken}`)
        .expect(404);

      await request(app)
        .post(`/api/v1/projects/${project.id}/keys`)
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ api_key: 'anything_at_all_0000' })
        .expect(404);
    });
  });

  describe('the chat log', () => {
    it('keeps the acting person even when the organization paid', async () => {
      const log = await AiChatLog.create({
        sessionId: '22222222-2222-4222-8222-222222222222',
        accountId: orgAccount.id,
        userAccountId: memberAccount.id,
        userPrompt: 'List my projects',
        aiAnswer: 'You have none yet.',
        tokenUsage: 42,
        totalTokenUsage: 42,
      });

      const stored = await AiChatLog.findByPk(log.id);
      expect(stored.accountId).toBe(orgAccount.id);
      expect(stored.userAccountId).toBe(memberAccount.id);
      expect(stored.toPublicJson().user_id).toBe(memberAccount.id);
    });

    it('numbers rows in insertion order, which is how a session is replayed', async () => {
      const first = await AiChatLog.create({
        sessionId: '33333333-3333-4333-8333-333333333333',
        accountId: memberAccount.id,
        userAccountId: memberAccount.id,
        userPrompt: 'One',
        aiAnswer: 'First',
        tokenUsage: 10,
        totalTokenUsage: 10,
      });

      const second = await AiChatLog.create({
        sessionId: '33333333-3333-4333-8333-333333333333',
        accountId: memberAccount.id,
        userAccountId: memberAccount.id,
        userPrompt: 'Two',
        aiAnswer: 'Second',
        tokenUsage: 15,
        totalTokenUsage: 25,
      });

      expect(second.id).toBeGreaterThan(first.id);
      expect(second.totalTokenUsage).toBe(25);
    });

    it('accepts a row with no embedding, so an unconfigured account still chats', async () => {
      const log = await AiChatLog.create({
        sessionId: '44444444-4444-4444-8444-444444444444',
        accountId: memberAccount.id,
        userAccountId: memberAccount.id,
        userPrompt: 'No vectors here',
        aiAnswer: 'None needed.',
      });

      const stored = await AiChatLog.findByPk(log.id);
      expect(stored.embedding).toBeNull();
      expect(stored.toPublicJson().has_embedding).toBe(false);
    });

    it('leaves the vector out of the client representation', async () => {
      const log = await AiChatLog.create({
        sessionId: '55555555-5555-4555-8555-555555555555',
        accountId: memberAccount.id,
        userAccountId: memberAccount.id,
        userPrompt: 'With a vector',
        aiAnswer: 'Stored.',
        embedding: JSON.stringify([0.1, 0.2, 0.3]),
      });

      const json = log.toPublicJson();
      expect(json.has_embedding).toBe(true);
      expect(json.embedding).toBeUndefined();
    });

    it('goes away with the namespace it belongs to', async () => {
      const doomed = await registerAccount(app, {
        user_id: 'ai_doomed',
        email: 'ai_doomed@example.test',
      });

      await AiChatLog.create({
        sessionId: '66666666-6666-4666-8666-666666666666',
        accountId: doomed.account.id,
        userAccountId: doomed.account.id,
        userPrompt: 'Anybody there',
        aiAnswer: 'For now.',
      });

      await Account.destroy({ where: { id: doomed.account.id } });

      expect(await AiChatLog.count({ where: { accountId: doomed.account.id } })).toBe(0);
    });
  });
});
