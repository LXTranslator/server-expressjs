'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
} = require('./helpers/testApp');
const { ApiUsageLog } = require('../src/infrastructure/database/models');
const usageService = require('../src/modules/usage/usage.service');

/*
 * The record of what has been done on an account.
 *
 * Once a credential can act without a person present, nothing else answers
 * "what has been done here". A session belongs to somebody who remembers using
 * it; a token in a build server does not, and "this token has not been used in
 * four months" or "this token deleted forty files on Tuesday" are the only ways
 * to notice that it is either dead weight or in somebody else's hands.
 *
 * What is deliberately absent matters as much as what is present, so several of
 * these assert that nothing sensitive was kept.
 */

describe('API usage', () => {
  let app;
  let owner;

  beforeAll(async () => {
    app = await setupTestApp();
    owner = await registerAccount(app, {
      user_id: 'usage_owner',
      email: 'usage_owner@example.test',
    });
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  /**
   * Drains the buffer so what was queued is readable.
   *
   * @returns {Promise<void>}
   */
  async function drain() {
    await usageService.flush();
  }

  describe('what gets recorded', () => {
    it('records an authenticated request once it has finished', async () => {
      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      await drain();

      const rows = await ApiUsageLog.findAll({
        where: { accountId: owner.account.id },
        order: [['id', 'DESC']],
      });

      const entry = rows.find((row) => row.path === '/api/v1/auth/me');
      expect(entry).toBeDefined();
      expect(entry.method).toBe('GET');
      expect(entry.statusCode).toBe(200);
      expect(entry.credentialKind).toBe('SESSION');
    });

    it('records the real status, including a failure', async () => {
      // Attached to the response rather than wrapped around the handler, so an
      // error handler changing the status long after the route decided is
      // still what gets written.
      await request(app)
        .get('/api/v1/projects/999999')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(404);

      await drain();

      const entry = await ApiUsageLog.findOne({
        where: { accountId: owner.account.id, path: '/api/v1/projects/999999' },
      });

      expect(entry.statusCode).toBe(404);
    });

    it('says which credential was used, so machine traffic is distinguishable', async () => {
      const created = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: 'usage token' })
        .expect(201);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${created.body.data.token}`)
        .expect(200);

      await drain();

      const entry = await ApiUsageLog.findOne({
        where: { accountId: owner.account.id, sessionId: created.body.data.api_token.id },
      });

      expect(entry).not.toBeNull();
      expect(entry.credentialKind).toBe('API');
    });

    it('does not record an unauthenticated request', async () => {
      // There is no account to attribute one to, and writing rows for people
      // who are not the account holder is the wrong place for sign in attempts
      // to live.
      const before = await ApiUsageLog.count();

      await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier: 'usage_owner', password: 'wrong password entirely' })
        .expect(401);

      await drain();

      expect(await ApiUsageLog.count()).toBe(before);
    });

    it('does not record the health probe', async () => {
      await request(app).get('/api/v1/health').expect(200);
      await drain();

      expect(await ApiUsageLog.count({ where: { path: '/api/v1/health' } })).toBe(0);
    });
  });

  describe('what is deliberately not recorded', () => {
    it('drops the query string, which carries what somebody typed', async () => {
      await request(app)
        .get(`/api/v1/namespaces/${owner.account.user_id}/chat/search`)
        .query({ q: 'a private search phrase' })
        .set('Authorization', `Bearer ${owner.token}`);

      await drain();

      const rows = await ApiUsageLog.findAll({ where: { accountId: owner.account.id } });
      const serialised = JSON.stringify(rows.map((row) => row.toJSON()));

      expect(serialised).not.toContain('a private search phrase');
      expect(rows.some((row) => row.path.endsWith('/chat/search'))).toBe(true);
    });

    it('keeps no request body, so nothing sensitive accumulates here', async () => {
      // A body carries the very things this system is careful about elsewhere.
      // A log that accumulated them would quietly become the most sensitive
      // table in the schema.
      await request(app)
        .post(`/api/v1/namespaces/${owner.account.user_id}/settings/ai_keys`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ provider: 'mock', api_key: 'sk_secret_never_logged_1234' })
        .expect(201);

      await drain();

      const rows = await ApiUsageLog.findAll({ where: { accountId: owner.account.id } });
      expect(JSON.stringify(rows.map((row) => row.toJSON()))).not.toContain(
        'sk_secret_never_logged_1234',
      );
    });

    it('has no column that could hold a body or a header', async () => {
      // Structural rather than incidental: there is nowhere to put one.
      const columns = Object.keys(ApiUsageLog.rawAttributes);

      expect(columns).not.toContain('body');
      expect(columns).not.toContain('headers');
      expect(columns).not.toContain('ipAddress');
      expect(columns.sort()).toEqual([
        'accountId',
        'createdAt',
        'credentialKind',
        'durationMs',
        'id',
        'method',
        'path',
        'sessionId',
        'statusCode',
      ]);
    });
  });

  describe('reading it back', () => {
    it('returns this account activity, newest first', async () => {
      const response = await request(app)
        .get('/api/v1/auth/usage')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(response.body.data.usage.length).toBeGreaterThan(0);

      const ids = response.body.data.usage.map((entry) => entry.id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    });

    it('narrows to one credential, which is how a token is audited', async () => {
      const created = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: 'audited' })
        .expect(201);

      const project = await createProject(app, owner.token, owner.account.user_id, {
        name: 'audited_work',
      });

      await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set('Authorization', `Bearer ${created.body.data.token}`)
        .expect(200);

      await drain();

      const response = await request(app)
        .get('/api/v1/auth/usage')
        .query({ session_id: created.body.data.api_token.id })
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(response.body.data.usage.length).toBeGreaterThan(0);
      expect(
        response.body.data.usage.every(
          (entry) => entry.session_id === created.body.data.api_token.id,
        ),
      ).toBe(true);
    });

    it('never shows another account activity', async () => {
      const outsider = await registerAccount(app, {
        user_id: 'usage_outsider',
        email: 'usage_outsider@example.test',
      });

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);

      await drain();

      const response = await request(app)
        .get('/api/v1/auth/usage')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);

      const rows = await ApiUsageLog.findAll({ where: { accountId: owner.account.id } });
      const ownerIds = new Set(rows.map((row) => row.id));

      expect(response.body.data.usage.every((entry) => !ownerIds.has(entry.id))).toBe(true);
    });

    it('summarises by credential, which is what makes an unfamiliar one visible', async () => {
      const response = await request(app)
        .get('/api/v1/auth/usage/summary')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(response.body.data.total_requests).toBeGreaterThan(0);
      expect(response.body.data.by_credential.length).toBeGreaterThan(0);

      const totals = response.body.data.by_credential.reduce(
        (sum, entry) => sum + entry.requests,
        0,
      );
      expect(totals).toBe(response.body.data.total_requests);
    });

    it('refuses an undeclared query field', async () => {
      await request(app)
        .get('/api/v1/auth/usage')
        .query({ account_id: 'somebody_else' })
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(422);
    });
  });

  describe('the buffer', () => {
    it('does not write on the request path', async () => {
      // The response returns without knowing whether the row was written, which
      // is the whole reason this is buffered.
      usageService.resetBuffer();

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(usageService.getBufferState().pending).toBeGreaterThan(0);

      await drain();
      expect(usageService.getBufferState().pending).toBe(0);
    });

    it('drops the oldest rather than growing without limit', async () => {
      // An unbounded buffer turns a database outage into a memory exhaustion,
      // which is a worse failure than the gap it was avoiding.
      usageService.resetBuffer();

      for (let index = 0; index < usageService.MAX_BUFFERED + 10; index += 1) {
        usageService.record({
          accountId: owner.account.id,
          sessionId: null,
          credentialKind: null,
          method: 'GET',
          path: `/api/v1/filler/${index}`,
          statusCode: 200,
          durationMs: 1,
          createdAt: new Date(),
        });
      }

      const state = usageService.getBufferState();
      expect(state.pending).toBe(usageService.MAX_BUFFERED);
      expect(state.dropped).toBeGreaterThan(0);

      usageService.resetBuffer();
    });

    it('survives a write that fails rather than retrying forever', async () => {
      // These rows describe requests that already returned. Holding them to try
      // again would trade a gap in the record for unbounded growth during
      // exactly the incident that caused the failure.
      usageService.resetBuffer();

      const original = ApiUsageLog.bulkCreate;
      ApiUsageLog.bulkCreate = jest.fn(async () => {
        throw new Error('The database is unavailable.');
      });

      try {
        usageService.record({
          accountId: owner.account.id,
          sessionId: null,
          credentialKind: null,
          method: 'GET',
          path: '/api/v1/doomed',
          statusCode: 200,
          durationMs: 1,
          createdAt: new Date(),
        });

        await usageService.flush();

        expect(usageService.getBufferState().pending).toBe(0);
        expect(usageService.getBufferState().failures).toBe(1);
      } finally {
        ApiUsageLog.bulkCreate = original;
        usageService.resetBuffer();
      }
    });
  });

  describe('housekeeping', () => {
    it('removes entries past the retention window', async () => {
      await drain();

      const row = await ApiUsageLog.findOne({ where: { accountId: owner.account.id } });
      await ApiUsageLog.update(
        { createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
        { where: { id: row.id } },
      );

      const removed = await usageService.purgeOldUsage(90);

      expect(removed).toBeGreaterThan(0);
      expect(await ApiUsageLog.findByPk(row.id)).toBeNull();
    });

    it('goes away with the account it belongs to', async () => {
      const doomed = await registerAccount(app, {
        user_id: 'usage_doomed',
        email: 'usage_doomed@example.test',
      });

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${doomed.token}`)
        .expect(200);

      await drain();

      const { Account } = require('../src/infrastructure/database/models');
      const accountId = doomed.account.id;
      expect(await ApiUsageLog.count({ where: { accountId } })).toBeGreaterThan(0);

      await Account.destroy({ where: { id: accountId } });

      expect(await ApiUsageLog.count({ where: { accountId } })).toBe(0);
    });

    it('outlives the credential that made it', async () => {
      // An audit trail that disappeared when somebody deleted the token would
      // be exactly the wrong way round.
      const created = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: 'to be deleted' })
        .expect(201);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${created.body.data.token}`)
        .expect(200);

      await drain();

      const tokenId = created.body.data.api_token.id;
      expect(await ApiUsageLog.count({ where: { sessionId: tokenId } })).toBeGreaterThan(0);

      const { AccountSession } = require('../src/infrastructure/database/models');
      await AccountSession.destroy({ where: { id: tokenId } });

      expect(await ApiUsageLog.count({ where: { sessionId: tokenId } })).toBeGreaterThan(0);
    });
  });
});
