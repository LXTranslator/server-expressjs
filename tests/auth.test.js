'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  VALID_PASSWORD,
} = require('./helpers/testApp');
const { AuthToken } = require('../src/infrastructure/database/models');

describe('authentication', () => {
  let app;

  beforeAll(async () => {
    app = await setupTestApp();
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  describe('registration', () => {
    it('creates a personal namespace and returns a session', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          user_id: 'jetsada',
          email: 'jetsada@example.test',
          password: VALID_PASSWORD,
          confirm_password: VALID_PASSWORD,
        })
        .expect(201);

      expect(response.body.data.account.user_id).toBe('jetsada');
      expect(response.body.data.account.type).toBe('USER');
      expect(response.body.data.access_token).toEqual(expect.any(String));
    });

    it('never returns the password hash', async () => {
      const { account } = await registerAccount(app);
      expect(JSON.stringify(account)).not.toMatch(/password/i);
    });

    it('rejects a payload carrying an undeclared field', async () => {
      // Mass assignment: a caller must not be able to make itself an
      // organization namespace by adding a field the schema never declared.
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          user_id: 'sneaky_user',
          email: 'sneaky@example.test',
          password: VALID_PASSWORD,
          confirm_password: VALID_PASSWORD,
          type: 'ORG',
        })
        .expect(422);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a weak password', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          user_id: 'weak_user',
          email: 'weak@example.test',
          password: 'password',
          confirm_password: 'password',
        })
        .expect(422);

      expect(response.body.error.details.some((d) => d.field === 'password')).toBe(true);
    });

    it('rejects mismatched passwords', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          user_id: 'mismatch_user',
          email: 'mismatch@example.test',
          password: VALID_PASSWORD,
          confirm_password: 'Different1Password',
        })
        .expect(422);

      expect(response.body.error.details.some((d) => d.field === 'confirm_password')).toBe(true);
    });

    it('rejects an invalid user id format', async () => {
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          user_id: 'Invalid User!',
          email: 'invalid@example.test',
          password: VALID_PASSWORD,
          confirm_password: VALID_PASSWORD,
        })
        .expect(422);
    });

    it('refuses a duplicate user id', async () => {
      await registerAccount(app, { user_id: 'duplicate_one', email: 'dup1@example.test' });

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          user_id: 'duplicate_one',
          email: 'dup2@example.test',
          password: VALID_PASSWORD,
          confirm_password: VALID_PASSWORD,
        })
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  describe('availability check', () => {
    it('reports a free and a taken user id', async () => {
      await registerAccount(app, { user_id: 'taken_name', email: 'taken@example.test' });

      const taken = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'taken_name' })
        .expect(200);
      expect(taken.body.data.user_id_available).toBe(false);

      const free = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'totally_free' })
        .expect(200);
      expect(free.body.data.user_id_available).toBe(true);
    });
  });

  /*
   * A namespace occupies the first segment of a client URL, so an account named
   * after a path the client already routes would never be reachable. The probe
   * and the form must agree about that, or the interface offers a name it then
   * refuses to create.
   */
  describe('reserved namespace identifiers', () => {
    it.each(['api', 'assets', 'login', 'namespaces', 'organizations', 'register', 'settings'])(
      'refuses to register %s',
      async (userId) => {
        const response = await request(app)
          .post('/api/v1/auth/register')
          .send({
            user_id: userId,
            email: `${userId}@example.test`,
            password: VALID_PASSWORD,
            confirm_password: VALID_PASSWORD,
          })
          .expect(422);

        expect(response.body.error.details.some((item) => item.field === 'user_id')).toBe(true);
      },
    );

    it('reports a reserved identifier as unavailable rather than rejecting the probe', async () => {
      const response = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'settings' })
        .expect(200);

      expect(response.body.data.user_id_available).toBe(false);
    });

    it('refuses a reserved identifier for an organization', async () => {
      const account = await registerAccount(app, {
        user_id: 'org_maker',
        email: 'org_maker@example.test',
      });

      await request(app)
        .post('/api/v1/namespaces/organizations')
        .set('Authorization', `Bearer ${account.token}`)
        .send({ user_id: 'namespaces', email: 'reserved_org@example.test' })
        .expect(422);
    });

    it('leaves an ordinary identifier alone', async () => {
      // The list covers real path collisions only, so common names such as
      // admin stay available.
      const response = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'admin' })
        .expect(200);

      expect(response.body.data.user_id_available).toBe(true);
    });
  });

  describe('login', () => {
    it('accepts either the user id or the email address', async () => {
      await registerAccount(app, { user_id: 'dual_login', email: 'dual@example.test' });

      for (const identifier of ['dual_login', 'dual@example.test']) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ identifier, password: VALID_PASSWORD })
          .expect(200);
        expect(response.body.data.access_token).toEqual(expect.any(String));
      }
    });

    it('gives the same message for a wrong password and an unknown account', async () => {
      await registerAccount(app, { user_id: 'known_user', email: 'known@example.test' });

      const wrongPassword = await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier: 'known_user', password: 'Wr0ngPassword!' })
        .expect(401);

      const unknownAccount = await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier: 'no_such_user', password: 'Wr0ngPassword!' })
        .expect(401);

      // Identical wording is what stops this endpoint being used to discover
      // which accounts exist.
      expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
    });

    it('locks the account after repeated failures', async () => {
      await registerAccount(app, { user_id: 'lockme', email: 'lockme@example.test' });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ identifier: 'lockme', password: 'Wr0ngPassword!' })
          .expect(401);
      }

      // The correct password is now refused too, because the account is locked.
      const locked = await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier: 'lockme', password: VALID_PASSWORD })
        .expect(401);

      expect(locked.body.error.message).toMatch(/locked/i);
    });
  });

  describe('session', () => {
    it('rejects a request with no token', async () => {
      await request(app).get('/api/v1/auth/me').expect(401);
    });

    it('rejects a forged token', async () => {
      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401);
    });

    it('returns the account for a valid token', async () => {
      const { token, account } = await registerAccount(app);
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.data.account.id).toBe(account.id);
    });
  });

  describe('forgot password', () => {
    it('answers identically for a known and an unknown address', async () => {
      await registerAccount(app, { user_id: 'reset_user', email: 'reset@example.test' });

      const known = await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'reset@example.test' })
        .expect(200);

      const unknown = await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'nobody@example.test' })
        .expect(200);

      expect(known.body.data.message).toBe(unknown.body.data.message);
    });

    it('issues a token that expires in exactly ten minutes', async () => {
      await registerAccount(app, { user_id: 'ttl_user', email: 'ttl@example.test' });

      const before = Date.now();
      await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'ttl@example.test' })
        .expect(200);

      const record = await AuthToken.findOne({
        where: { purpose: 'PASSWORD_RESET' },
        order: [['created_at', 'DESC']],
      });

      const lifetimeMs = new Date(record.expiresAt).getTime() - before;
      // Ten minutes, allowing a small window for the request itself.
      expect(lifetimeMs).toBeGreaterThan(9 * 60 * 1000);
      expect(lifetimeMs).toBeLessThanOrEqual(10 * 60 * 1000 + 2000);
    });

    it('resets the password and invalidates the token after one use', async () => {
      await registerAccount(app, { user_id: 'once_user', email: 'once@example.test' });

      const forgot = await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'once@example.test' })
        .expect(200);

      const token = forgot.body.data.development_token;
      expect(token).toEqual(expect.any(String));

      const newPassword = 'BrandNewP4ss';

      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token, password: newPassword, confirm_password: newPassword })
        .expect(200);

      // The new password works.
      await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier: 'once_user', password: newPassword })
        .expect(200);

      // The old one does not.
      await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier: 'once_user', password: VALID_PASSWORD })
        .expect(401);

      // The token cannot be replayed.
      const replay = await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'Yet4notherPass', confirm_password: 'Yet4notherPass' })
        .expect(401);

      expect(replay.body.error.message).toMatch(/already been used|invalid|expired/i);
    });

    it('refuses a reset token that was minted for a different purpose', async () => {
      const { token: sessionToken } = await registerAccount(app, {
        user_id: 'purpose_user',
        email: 'purpose@example.test',
      });

      // A session token must not be redeemable as a password reset link.
      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({
          token: sessionToken,
          password: 'AnotherG00dPass',
          confirm_password: 'AnotherG00dPass',
        })
        .expect(401);
    });
  });
});
