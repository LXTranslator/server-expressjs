'use strict';

const request = require('supertest');
const { setupTestApp, teardownTestApp, registerAccount } = require('./helpers/testApp');
const { AccountSession } = require('../src/infrastructure/database/models');
const sessionService = require('../src/modules/auth/session.service');

/*
 * Sessions.
 *
 * A signed token proves who somebody is and nothing else. It cannot be taken
 * back, so before these rows existed signing out could only forget the token
 * locally: it stayed valid for the rest of its lifetime anywhere else it had
 * been copied, nobody could see where they were signed in, and a password
 * change left every other session running.
 *
 * So the row is the authority now, and these tests are mostly about the things
 * a stateless token could never do.
 */

/** Password matching the harness, needed to sign in a second time. */
const PASSWORD = 'Str0ngPassphrase';

describe('sessions', () => {
  let app;

  beforeAll(async () => {
    app = await setupTestApp();
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  /**
   * Signs in, optionally announcing a particular client.
   *
   * @param {string} identifier Account identifier.
   * @param {string} [userAgent] Client string to send.
   * @returns {Promise<string>} The session token.
   */
  async function signIn(identifier, userAgent) {
    const call = request(app)
      .post('/api/v1/auth/login')
      .send({ identifier, password: PASSWORD });

    if (userAgent !== undefined) call.set('User-Agent', userAgent);

    const response = await call.expect(200);
    return response.body.data.access_token;
  }

  describe('signing in more than once', () => {
    it('gives every sign in its own session', async () => {
      // The case this exists for: one person, a laptop, a phone and a second
      // browser profile, all signed in at the same time.
      const registered = await registerAccount(app, {
        user_id: 'many_devices',
        email: 'many_devices@example.test',
      });

      const phone = await signIn('many_devices', 'LXTranslator/1.0 (iPhone)');
      const other = await signIn('many_devices', 'Mozilla/5.0 (X11; Linux)');

      expect(new Set([registered.token, phone, other]).size).toBe(3);

      const listed = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${phone}`)
        .expect(200);

      expect(listed.body.data.sessions).toHaveLength(3);
      expect(listed.body.data.sessions.filter((entry) => entry.current)).toHaveLength(1);
    });

    it('records what asked for each one, so a list is actionable', async () => {
      const token = await signIn('many_devices', 'LXTranslator/1.0 (Pixel 9)');

      const listed = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const current = listed.body.data.sessions.find((entry) => entry.current);
      expect(current.user_agent).toBe('LXTranslator/1.0 (Pixel 9)');
    });

    it('keeps every other session working when one signs out', async () => {
      const registered = await registerAccount(app, {
        user_id: 'independent',
        email: 'independent@example.test',
      });
      const second = await signIn('independent');

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(204);

      // The one that signed out is finished.
      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(401);

      // The other is untouched.
      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${second}`)
        .expect(200);
    });
  });

  describe('signing out', () => {
    it('really ends the session rather than forgetting it locally', async () => {
      // The property a stateless token cannot have. The token below is still
      // perfectly signed and nowhere near expiry; it stops working because the
      // row says so.
      const registered = await registerAccount(app, {
        user_id: 'revoked_user',
        email: 'revoked_user@example.test',
      });

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(204);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(401);

      expect(response.body.error.message).toMatch(/session has ended/i);
    });

    it('is not an error to sign out twice', async () => {
      const registered = await registerAccount(app, {
        user_id: 'twice_out',
        email: 'twice_out@example.test',
      });

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(204);

      // The second attempt cannot authenticate at all, which is the same
      // outcome by a shorter route.
      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(401);
    });
  });

  describe('ending one device from another', () => {
    it('revokes a named session', async () => {
      const registered = await registerAccount(app, {
        user_id: 'device_manager',
        email: 'device_manager@example.test',
      });
      const phone = await signIn('device_manager', 'LXTranslator/1.0 (iPhone)');

      const listed = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      const other = listed.body.data.sessions.find((entry) => !entry.current);

      await request(app)
        .delete(`/api/v1/auth/sessions/${other.id}`)
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(204);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${phone}`)
        .expect(401);
    });

    it('signs out everywhere else while staying signed in here', async () => {
      const registered = await registerAccount(app, {
        user_id: 'sweeper',
        email: 'sweeper@example.test',
      });
      const first = await signIn('sweeper');
      const second = await signIn('sweeper');

      const response = await request(app)
        .post('/api/v1/auth/sessions/revoke_others')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      expect(response.body.data.revoked).toBe(2);

      // The one that asked survives, which is what makes the action usable at
      // all: the alternative signs you out mid request.
      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      for (const token of [first, second]) {
        await request(app)
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      }
    });

    it('refuses to end a session belonging to somebody else', async () => {
      const mine = await registerAccount(app, {
        user_id: 'session_owner',
        email: 'session_owner@example.test',
      });
      const theirs = await registerAccount(app, {
        user_id: 'session_snooper',
        email: 'session_snooper@example.test',
      });

      const listed = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(200);

      // 404 rather than 403: a 403 would confirm the identifier names a real
      // session on somebody else's account.
      await request(app)
        .delete(`/api/v1/auth/sessions/${listed.body.data.sessions[0].id}`)
        .set('Authorization', `Bearer ${theirs.token}`)
        .expect(404);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(200);
    });

    it('lists nobody else sessions', async () => {
      const outsider = await registerAccount(app, {
        user_id: 'session_outsider',
        email: 'session_outsider@example.test',
      });

      const listed = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);

      expect(listed.body.data.sessions).toHaveLength(1);
      expect(listed.body.data.sessions[0].current).toBe(true);
    });
  });

  describe('what a changed password does to them', () => {
    it('ends every other session, keeping the one that made the change', async () => {
      const registered = await registerAccount(app, {
        user_id: 'password_changer',
        email: 'password_changer@example.test',
      });
      const elsewhere = await signIn('password_changer');

      const confirmed = await request(app)
        .post('/api/v1/settings/confirm')
        .set('Authorization', `Bearer ${registered.token}`)
        .send({ password: PASSWORD })
        .expect(200);

      const changed = await request(app)
        .patch('/api/v1/settings/password')
        .set('Authorization', `Bearer ${registered.token}`)
        .send({
          token: confirmed.body.data.token,
          password: 'An0therStrongPass',
          confirm_password: 'An0therStrongPass',
        })
        .expect(200);

      expect(changed.body.data.message).toMatch(/signed out/i);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${elsewhere}`)
        .expect(401);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);
    });

    it('ends every session at all when the password is reset', async () => {
      // A reset is the flow for a password somebody may have lost control of,
      // so nothing survives it, including the session asking.
      const registered = await registerAccount(app, {
        user_id: 'password_resetter',
        email: 'password_resetter@example.test',
      });

      const forgot = await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'password_resetter@example.test' })
        .expect(200);

      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({
          token: forgot.body.data.development_token,
          password: 'R3setPassphrase',
          confirm_password: 'R3setPassphrase',
        })
        .expect(200);

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(401);
    });
  });

  describe('what is stored', () => {
    it('never stores the token itself', async () => {
      const registered = await registerAccount(app, {
        user_id: 'hash_only',
        email: 'hash_only@example.test',
      });

      const rows = await AccountSession.findAll();
      const serialised = JSON.stringify(rows.map((row) => row.toJSON()));

      expect(serialised).not.toContain(registered.token);
    });

    it('keeps the digest out of the client representation', async () => {
      const registered = await registerAccount(app, {
        user_id: 'no_digest',
        email: 'no_digest@example.test',
      });

      const listed = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      const json = JSON.stringify(listed.body);
      expect(json).not.toContain('token_hash');
      expect(json).not.toContain('tokenHash');
    });

    it('goes away with the account it belongs to', async () => {
      const doomed = await registerAccount(app, {
        user_id: 'session_doomed',
        email: 'session_doomed@example.test',
      });

      const { Account } = require('../src/infrastructure/database/models');
      const accountId = doomed.account.id;
      await Account.destroy({ where: { id: accountId } });

      expect(await AccountSession.count({ where: { accountId } })).toBe(0);
    });
  });

  describe('housekeeping', () => {
    it('does not rewrite the used timestamp on every request', async () => {
      // A write per request, on a column whose only question is "is this still
      // in use", would make every read of every endpoint a write.
      const registered = await registerAccount(app, {
        user_id: 'touch_throttle',
        email: 'touch_throttle@example.test',
      });

      await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      const session = await AccountSession.findOne({
        where: { accountId: registered.account.id },
      });
      await session.update({ lastUsedAt: new Date() });
      const before = session.lastUsedAt.getTime();

      await sessionService.touch(session);
      await session.reload();

      expect(session.lastUsedAt.getTime()).toBe(before);
    });

    it('refreshes it once the interval has passed', async () => {
      const registered = await registerAccount(app, {
        user_id: 'touch_refresh',
        email: 'touch_refresh@example.test',
      });

      const session = await AccountSession.findOne({
        where: { accountId: registered.account.id },
      });

      const stale = new Date(Date.now() - sessionService.LAST_USED_REFRESH_MS - 1000);
      await session.update({ lastUsedAt: stale });

      await sessionService.touch(session);
      await session.reload();

      expect(session.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());
    });

    it('removes rows that have been dead long enough to be uninteresting', async () => {
      const registered = await registerAccount(app, {
        user_id: 'purge_me',
        email: 'purge_me@example.test',
      });

      const session = await AccountSession.findOne({
        where: { accountId: registered.account.id },
      });
      await session.update({ revokedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });

      const removed = await sessionService.purgeDeadSessions(30);

      expect(removed).toBeGreaterThan(0);
      expect(await AccountSession.findByPk(session.id)).toBeNull();
    });
  });
});
