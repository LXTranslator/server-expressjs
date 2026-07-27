'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
} = require('./helpers/testApp');
const { AccountSession } = require('../src/infrastructure/database/models');
const apiTokenService = require('../src/modules/auth/apiToken.service');

/*
 * Using the API from a machine.
 *
 * A session token comes from signing in with a password and lasts an hour,
 * which is right for a browser and useless for a build script: a script cannot
 * hold a password and cannot sign in again every hour. Without these the only
 * way to reach the API from a machine was to post a password to the login
 * endpoint and juggle what came back.
 */

describe('API tokens', () => {
  let app;
  let owner;

  beforeAll(async () => {
    app = await setupTestApp();
    owner = await registerAccount(app, {
      user_id: 'api_owner',
      email: 'api_owner@example.test',
    });
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  /**
   * Creates a token as the owner.
   *
   * @param {object} [body] Payload overrides.
   * @returns {Promise<object>} The response body's data.
   */
  async function createToken(body = {}) {
    const response = await request(app)
      .post('/api/v1/auth/api_tokens')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'build script', ...body })
      .expect(201);

    return response.body.data;
  }

  describe('creating one', () => {
    it('returns the token exactly once, and says so', async () => {
      const data = await createToken({ name: 'ci pipeline' });

      expect(data.token).toMatch(/^lxt_/);
      expect(data.warning).toMatch(/cannot be shown again/i);
      expect(data.api_token.name).toBe('ci pipeline');
      expect(data.api_token.kind).toBe('API');
    });

    it('never shows it again', async () => {
      const data = await createToken({ name: 'shown once' });

      const listed = await request(app)
        .get('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(JSON.stringify(listed.body)).not.toContain(data.token);

      // Identifiable without being usable: the last four characters are enough
      // to tell two tokens apart in a list and not enough to use either.
      const entry = listed.body.data.api_tokens.find(
        (token) => token.id === data.api_token.id,
      );
      expect(entry.masked_token).toBe(`****${data.token.slice(-4)}`);
    });

    it('stores a digest rather than the token', async () => {
      const data = await createToken({ name: 'hashed' });

      const rows = await AccountSession.findAll({ where: { kind: 'API' } });
      expect(JSON.stringify(rows.map((row) => row.toJSON()))).not.toContain(data.token);
    });

    it('carries a prefix, so a leak can be recognised', async () => {
      // A credential that announces what it is can be caught by a secret
      // scanner in a commit, a log or a bug report.
      const data = await createToken({ name: 'prefixed' });
      expect(data.token.startsWith(apiTokenService.TOKEN_PREFIX)).toBe(true);
    });

    it('requires a name', async () => {
      await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({})
        .expect(422);
    });

    it('refuses an undeclared field, so account_id cannot be smuggled in', async () => {
      await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: 'sneaky', account_id: 'somebody_else' })
        .expect(422);
    });

    it('refuses a life longer than the ceiling', async () => {
      await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: 'forever', expires_in_days: 4000 })
        .expect(422);
    });
  });

  describe('using one', () => {
    it('authenticates an ordinary request', async () => {
      const { token } = await createToken({ name: 'reader' });

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.data.account.user_id).toBe('api_owner');
    });

    it('reaches the same endpoints a browser session does', async () => {
      // The point of the whole thing: a script does what a person does.
      const { token } = await createToken({ name: 'project maker' });

      const created = await request(app)
        .post('/api/v1/namespaces/api_owner/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'made_by_script' })
        .expect(201);

      const listed = await request(app)
        .get('/api/v1/namespaces/api_owner/projects')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(listed.body.data.projects.map((project) => project.id)).toContain(
        created.body.data.project.id,
      );
    });

    it('uploads a file, which is what a build script is for', async () => {
      const { token } = await createToken({ name: 'uploader' });
      const project = await createProject(app, owner.token, 'api_owner', {
        name: 'script_uploads',
      });

      await request(app)
        .post(`/api/v1/projects/${project.id}/files`)
        .set('Authorization', `Bearer ${token}`)
        .field('target_langs', 'th_th')
        .attach('file', Buffer.from(JSON.stringify({ greeting: 'Hello' })), 'en_us.json')
        .expect(202);
    });

    it('cannot reach a namespace its account does not belong to', async () => {
      // A token is its account and nothing more. It carries no privilege the
      // person who made it does not have.
      const stranger = await registerAccount(app, {
        user_id: 'api_stranger',
        email: 'api_stranger@example.test',
      });
      const { token } = await createToken({ name: 'nosy' });

      await request(app)
        .get(`/api/v1/namespaces/${stranger.account.user_id}/projects`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('is rejected once revoked, on the next request rather than at expiry', async () => {
      const data = await createToken({ name: 'short lived' });

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${data.token}`)
        .expect(200);

      await request(app)
        .delete(`/api/v1/auth/api_tokens/${data.api_token.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const rejected = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${data.token}`)
        .expect(401);

      expect(rejected.body.error.message).toMatch(/revoked|invalid|expired/i);
    });

    it('is rejected once it has expired', async () => {
      const data = await createToken({ name: 'expiring', expires_in_days: 1 });

      const row = await AccountSession.findByPk(data.api_token.id);
      await row.update({ expiresAt: new Date(Date.now() - 1000) });

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${data.token}`)
        .expect(401);
    });

    it('rejects a made up token that merely looks right', async () => {
      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer lxt_notarealtokenatallbutlookslikeone')
        .expect(401);
    });
  });

  describe('what a token may not do', () => {
    it('cannot mint another token', async () => {
      // Otherwise one leaked credential replaces itself forever and revoking
      // the original achieves nothing.
      const { token } = await createToken({ name: 'self replicator' });

      const refused = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'child' })
        .expect(403);

      expect(refused.body.error.message).toMatch(/sign in to manage api tokens/i);
    });

    it('cannot revoke a token', async () => {
      const victim = await createToken({ name: 'victim' });
      const { token } = await createToken({ name: 'attacker' });

      await request(app)
        .delete(`/api/v1/auth/api_tokens/${victim.api_token.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('may still read the list, so a script can check its own standing', async () => {
      const { token } = await createToken({ name: 'reader of lists' });

      await request(app)
        .get('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  describe('managing them', () => {
    it('lists only this account tokens', async () => {
      const outsider = await registerAccount(app, {
        user_id: 'api_outsider',
        email: 'api_outsider@example.test',
      });

      const listed = await request(app)
        .get('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);

      expect(listed.body.data.api_tokens).toEqual([]);
    });

    it('refuses to revoke a token belonging to somebody else', async () => {
      const victim = await createToken({ name: 'not yours' });
      const outsider = await registerAccount(app, {
        user_id: 'api_thief',
        email: 'api_thief@example.test',
      });

      // 404 rather than 403: a 403 would confirm the identifier names a real
      // token on somebody else's account.
      await request(app)
        .delete(`/api/v1/auth/api_tokens/${victim.api_token.id}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${victim.token}`)
        .expect(200);
    });

    it('keeps tokens out of the session list and sessions out of the token list', async () => {
      const separate = await registerAccount(app, {
        user_id: 'api_separate',
        email: 'api_separate@example.test',
      });

      await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${separate.token}`)
        .send({ name: 'machine' })
        .expect(201);

      const sessions = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${separate.token}`)
        .expect(200);

      const tokens = await request(app)
        .get('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${separate.token}`)
        .expect(200);

      expect(sessions.body.data.sessions.every((entry) => entry.kind === 'SESSION')).toBe(true);
      expect(tokens.body.data.api_tokens.every((entry) => entry.kind === 'API')).toBe(true);
    });

    it('refuses more tokens than an account may hold', async () => {
      const crowded = await registerAccount(app, {
        user_id: 'api_crowded',
        email: 'api_crowded@example.test',
      });

      for (let index = 0; index < apiTokenService.MAX_TOKENS_PER_ACCOUNT; index += 1) {
        await request(app)
          .post('/api/v1/auth/api_tokens')
          .set('Authorization', `Bearer ${crowded.token}`)
          .send({ name: `token ${index}` })
          .expect(201);
      }

      const refused = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${crowded.token}`)
        .send({ name: 'one too many' })
        .expect(400);

      expect(refused.body.error.message).toMatch(/may hold 20 API tokens/i);
    });

    it('survives a password change, unlike a session', async () => {
      // A machine credential is not a browser somebody wants signed out. It has
      // its own revoke, and rotating a password should not silently break every
      // build in the organization.
      const rotator = await registerAccount(app, {
        user_id: 'api_rotator',
        email: 'api_rotator@example.test',
      });

      const created = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${rotator.token}`)
        .send({ name: 'survives' })
        .expect(201);

      const confirmed = await request(app)
        .post('/api/v1/settings/confirm')
        .set('Authorization', `Bearer ${rotator.token}`)
        .send({ password: 'Str0ngPassphrase' })
        .expect(200);

      await request(app)
        .patch('/api/v1/settings/password')
        .set('Authorization', `Bearer ${rotator.token}`)
        .send({
          token: confirmed.body.data.token,
          password: 'R0tatedPassphrase',
          confirm_password: 'R0tatedPassphrase',
        })
        .expect(200);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${created.body.data.token}`)
        .expect(200);
    });

    it('does not survive a password reset, unlike a settings change', async () => {
      // The asymmetry is the point. A settings change is somebody tidying up
      // and must not break every build in the organization. A reset is the
      // flow for a password that may already be in somebody else's hands, and
      // whoever had it could have minted a token with it. So a reset takes
      // everything, machine credentials included.
      const compromised = await registerAccount(app, {
        user_id: 'api_compromised',
        email: 'api_compromised@example.test',
      });

      const created = await request(app)
        .post('/api/v1/auth/api_tokens')
        .set('Authorization', `Bearer ${compromised.token}`)
        .send({ name: 'possibly the attacker' })
        .expect(201);

      const forgot = await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'api_compromised@example.test' })
        .expect(200);

      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({
          token: forgot.body.data.development_token,
          password: 'Recl4imedPassphrase',
          confirm_password: 'Recl4imedPassphrase',
        })
        .expect(200);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${created.body.data.token}`)
        .expect(401);
    });
  });
});
