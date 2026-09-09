'use strict';

const request = require('supertest');
const totp = require('../src/core/totp');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  VALID_PASSWORD,
} = require('./helpers/testApp');

/**
 * Signing in with, and linking, a provider account.
 *
 * The properties that matter are the ones a working implementation still gets
 * wrong: that an unlinked identity is refused rather than quietly turned into
 * an account, that a state cannot be spent twice or by somebody else, that a
 * link state cannot be redeemed as a sign in, and that a provider sign in is
 * challenged for a second factor exactly as a password sign in is.
 *
 * The `mock` provider stands in for github.com and gitlab.com so the suite
 * reaches no network. Its authorization code carries the identity:
 * `"<id>|<username>|<email>"`.
 */

let app;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp();
});

/**
 * Starts a link flow and returns the state the provider would echo back.
 *
 * @param {string} token Session token.
 * @returns {Promise<string>} The state parameter.
 */
async function startLink(token) {
  const response = await request(app)
    .post('/api/v1/auth/oauth/mock/link/start')
    .set('Authorization', `Bearer ${token}`)
    .send({})
    .expect(200);

  return new URL(response.body.data.authorize_url).searchParams.get('state');
}

/**
 * Starts a sign in flow and returns its state.
 *
 * @returns {Promise<string>} The state parameter.
 */
async function startLogin() {
  const response = await request(app)
    .post('/api/v1/auth/oauth/mock/login/start')
    .send({})
    .expect(200);

  return new URL(response.body.data.authorize_url).searchParams.get('state');
}

/**
 * Links a provider identity to an account.
 *
 * @param {string} token Session token.
 * @param {string} code Mock authorization code carrying the identity.
 * @returns {Promise<object>} The stored identity.
 */
async function link(token, code) {
  const state = await startLink(token);
  const response = await request(app)
    .post('/api/v1/auth/oauth/link/callback')
    .set('Authorization', `Bearer ${token}`)
    .send({ state, code })
    .expect(201);

  return response.body.data.identity;
}

describe('the provider catalogue', () => {
  it('lists only what this deployment configured', async () => {
    const response = await request(app).get('/api/v1/auth/oauth/providers').expect(200);

    const names = response.body.data.providers.map((provider) => provider.name);

    // Neither real provider has credentials here, so neither may be offered.
    // This is the same state every existing deployment is in.
    expect(names).not.toContain('github');
    expect(names).not.toContain('gitlab');
    expect(names).toContain('mock');
  });

  it('needs no authentication, so a signed out visitor can be offered a button', async () => {
    await request(app).get('/api/v1/auth/oauth/providers').expect(200);
  });

  it('refuses to start a flow for an unconfigured provider, without failing', async () => {
    const response = await request(app)
      .post('/api/v1/auth/oauth/github/login/start')
      .send({})
      .expect(404);

    expect(response.body.error.message).toMatch(/not available/i);
  });

  it('refuses an unknown provider name', async () => {
    await request(app).post('/api/v1/auth/oauth/evilcorp/login/start').send({}).expect(404);
    await request(app).post('/api/v1/auth/oauth/constructor/login/start').send({}).expect(404);
  });

  it('builds an authorize URL with PKCE and a state, and no caller supplied redirect', async () => {
    const response = await request(app)
      .post('/api/v1/auth/oauth/mock/login/start')
      .send({})
      .expect(200);

    const url = new URL(response.body.data.authorize_url);

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toEqual(expect.any(String));
    expect(url.searchParams.get('state')).toEqual(expect.any(String));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/oauth-callback');
  });
});

describe('linking', () => {
  it('needs a session', async () => {
    await request(app).post('/api/v1/auth/oauth/mock/link/start').send({}).expect(401);
    await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .send({ state: 'x'.repeat(32), code: '1' })
      .expect(401);
  });

  it('binds an identity and lists it', async () => {
    const session = await registerAccount(app);
    const identity = await link(session.token, '4242|octocat|octo@example.test');

    expect(identity).toMatchObject({
      provider: 'mock',
      provider_username: 'octocat',
      provider_email: 'octo@example.test',
    });

    const list = await request(app)
      .get('/api/v1/auth/oauth/identities')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);

    expect(list.body.data.identities).toHaveLength(1);
    expect(list.body.data.identities[0].provider).toBe('mock');
  });

  it('refuses a state minted for a different account', async () => {
    const victim = await registerAccount(app);
    const attacker = await registerAccount(app);

    // The attacker starts a flow, then tries to have the victim's session
    // finish it. Without the account assertion this would bind the attacker's
    // provider identity to the victim's account, and hand them a way in.
    const attackerState = await startLink(attacker.token);

    const response = await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .set('Authorization', `Bearer ${victim.token}`)
      .send({ state: attackerState, code: '9001|attacker|attacker@example.test' })
      .expect(401);

    expect(response.body.error.message).toMatch(/does not belong to this session/i);

    const list = await request(app)
      .get('/api/v1/auth/oauth/identities')
      .set('Authorization', `Bearer ${victim.token}`)
      .expect(200);

    expect(list.body.data.identities).toHaveLength(0);
  });

  it('refuses a replayed state', async () => {
    const session = await registerAccount(app);
    const state = await startLink(session.token);

    await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ state, code: '5150|first|first@example.test' })
      .expect(201);

    await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ state, code: '5151|second|second@example.test' })
      .expect(401);
  });

  it('refuses a sign in state spent on the link callback', async () => {
    const session = await registerAccount(app);
    const loginState = await startLogin();

    await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ state: loginState, code: '7000|crossed|crossed@example.test' })
      .expect(401);
  });

  it('refuses a link state spent on the sign in callback', async () => {
    const session = await registerAccount(app);
    const linkState = await startLink(session.token);

    await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state: linkState, code: '7001|crossed|crossed@example.test' })
      .expect(401);
  });

  it('refuses an identity already linked to another account', async () => {
    const first = await registerAccount(app);
    const second = await registerAccount(app);

    await link(first.token, '8080|shared|shared@example.test');

    const state = await startLink(second.token);
    const response = await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .set('Authorization', `Bearer ${second.token}`)
      .send({ state, code: '8080|shared|shared@example.test' })
      .expect(409);

    expect(response.body.error.message).toMatch(/already linked/i);
  });

  it('unlinks, and then that identity can no longer sign in', async () => {
    const session = await registerAccount(app);
    await link(session.token, '3131|leaving|leaving@example.test');

    await request(app)
      .delete('/api/v1/auth/oauth/mock')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(204);

    const state = await startLogin();
    await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state, code: '3131|leaving|leaving@example.test' })
      .expect(401);
  });

  it('rejects an undeclared field rather than ignoring it', async () => {
    const session = await registerAccount(app);
    const state = await startLink(session.token);

    // A caller supplied redirect_uri is exactly what must not be accepted.
    await request(app)
      .post('/api/v1/auth/oauth/link/callback')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ state, code: '1', redirect_uri: 'https://evil.test/steal' })
      .expect(422);
  });
});

describe('signing in', () => {
  it('refuses an identity nobody has linked, and creates nothing', async () => {
    const state = await startLogin();

    const response = await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state, code: '6060|stranger|stranger@example.test' })
      .expect(401);

    expect(response.body.error.message).toMatch(/not linked yet/i);

    // An account minted here would have no password, and an account matched by
    // the address the provider reported would belong to whoever controls that
    // mailbox. Neither happens.
    const second = await startLogin();
    await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state: second, code: '6060|stranger|stranger@example.test' })
      .expect(401);
  });

  it('signs in through a linked identity', async () => {
    const session = await registerAccount(app);
    await link(session.token, '1234|linked|linked@example.test');

    const state = await startLogin();
    const response = await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state, code: '1234|linked|linked@example.test' })
      .expect(200);

    expect(response.body.data.access_token).toEqual(expect.any(String));
    expect(response.body.data.account.user_id).toBe(session.account.user_id);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${response.body.data.access_token}`)
      .expect(200);
  });

  it('matches on the provider id, never the username', async () => {
    const session = await registerAccount(app);
    await link(session.token, '2468|original|original@example.test');

    // The person renamed themselves at the provider. Same account, new name.
    const state = await startLogin();
    const response = await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state, code: '2468|renamed|renamed@example.test' })
      .expect(200);

    expect(response.body.data.account.user_id).toBe(session.account.user_id);

    const list = await request(app)
      .get('/api/v1/auth/oauth/identities')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);

    // The display name follows along, but it was never what found the row.
    expect(list.body.data.identities[0].provider_username).toBe('renamed');
  });

  it('does not sign in somebody who merely took the old username', async () => {
    const session = await registerAccount(app);
    await link(session.token, '1357|desirable|desirable@example.test');

    // Somebody else claimed the released username at the provider. Their
    // numeric id is different, so they are a stranger here.
    const state = await startLogin();
    await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state, code: '9999|desirable|desirable@example.test' })
      .expect(401);
  });

  it('is challenged for a second factor exactly as a password sign in is', async () => {
    const session = await registerAccount(app);
    await link(session.token, '5555|guarded|guarded@example.test');

    const confirm = await request(app)
      .post('/api/v1/settings/confirm')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: VALID_PASSWORD })
      .expect(200);

    const setup = await request(app)
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: confirm.body.data.token })
      .expect(201);

    const secret = totp.base32Decode(setup.body.data.secret);

    const second = await request(app)
      .post('/api/v1/settings/confirm')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${session.token}`)
      .send({
        settings_token: second.body.data.token,
        code: totp.deriveCode(secret, totp.counterAt() - 1),
      })
      .expect(200);

    const state = await startLogin();
    const response = await request(app)
      .post('/api/v1/auth/oauth/login/callback')
      .send({ state, code: '5555|guarded|guarded@example.test' })
      .expect(200);

    /*
     * This is the bypass the shared sign in gate exists to prevent. A callback
     * that minted its own token would hand a session to anybody holding a
     * linked provider account, second factor or not.
     */
    expect(response.body.data.mfa_required).toBe(true);
    expect(response.body.data.access_token).toBeUndefined();

    const completed = await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({
        challenge_token: response.body.data.challenge_token,
        code: totp.deriveCode(secret, totp.counterAt()),
      })
      .expect(200);

    expect(completed.body.data.access_token).toEqual(expect.any(String));
  });
});
