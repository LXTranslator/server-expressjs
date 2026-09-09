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
 * The second factor.
 *
 * The properties worth protecting here are the ones a working implementation
 * can still get wrong: that a correct password alone yields no session, that a
 * code cannot be spent twice inside the window that still considers it current,
 * that the challenge credential is inert as a bearer token, and that guessing
 * the second factor draws on the same budget as guessing the password.
 */

let app;

// Sequelize cannot reopen a closed connection, so this happens once per file
// rather than once per describe.
beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp();
});

/**
 * Confirms a second factor and returns everything needed to sign in with it.
 *
 * @param {object} session Registered account from `registerAccount`.
 * @returns {Promise<{secret: Buffer, recoveryCodes: string[]}>}
 */
async function enableSecondFactor(session) {
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

  const secondConfirm = await request(app)
    .post('/api/v1/settings/confirm')
    .set('Authorization', `Bearer ${session.token}`)
    .send({ password: VALID_PASSWORD })
    .expect(200);

  /*
   * Confirmation deliberately spends the *previous* time step, not the current
   * one. A step is spent for good once accepted, so confirming with the current
   * code would leave every test below unable to sign in with it a moment later
   * — which is the replay defence doing its job, not a bug to work around.
   */
  const enable = await request(app)
    .post('/api/v1/auth/mfa/enable')
    .set('Authorization', `Bearer ${session.token}`)
    .send({
      settings_token: secondConfirm.body.data.token,
      code: totp.deriveCode(secret, totp.counterAt() - 1),
    })
    .expect(200);

  return { secret, recoveryCodes: enable.body.data.recovery_codes };
}

describe('totp primitives', () => {
  // RFC 6238 appendix B, the SHA-1 rows. The last one exceeds 32 bits, which is
  // what catches a counter written as a 32 bit integer.
  const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the RFC 6238 vector at %i seconds', (seconds, expected) => {
    expect(totp.deriveCode(RFC_SECRET, totp.counterAt(seconds * 1000))).toBe(expected);
  });

  it('round trips base32 and matches the RFC 4648 vector', () => {
    expect(totp.base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(totp.base32Decode(totp.base32Encode(RFC_SECRET))).toEqual(RFC_SECRET);
  });

  it('tolerates the spacing a person types', () => {
    expect(totp.base32Decode('mzxw 6ytb-oi')).toEqual(Buffer.from('foobar'));
  });

  it('accepts one step of drift either way and nothing beyond it', () => {
    const now = Date.now();
    const current = totp.counterAt(now);

    for (const offset of [-1, 0, 1]) {
      const code = totp.deriveCode(RFC_SECRET, current + offset);
      expect(totp.verifyCode(RFC_SECRET, code, { at: now }).valid).toBe(true);
    }

    for (const offset of [-2, 2]) {
      const code = totp.deriveCode(RFC_SECRET, current + offset);
      expect(totp.verifyCode(RFC_SECRET, code, { at: now }).valid).toBe(false);
    }
  });

  it('refuses a code that is not six digits before doing any work', () => {
    expect(totp.verifyCode(RFC_SECRET, 'abcdef').valid).toBe(false);
    expect(totp.verifyCode(RFC_SECRET, '12345').valid).toBe(false);
    expect(totp.verifyCode(RFC_SECRET, '1234567').valid).toBe(false);
    expect(totp.verifyCode(RFC_SECRET, '').valid).toBe(false);
  });

  it('builds a URI an authenticator can read', () => {
    const uri = totp.buildOtpauthUri({
      issuer: 'LXTranslator',
      accountName: 'jetsada',
      base32Secret: 'MZXW6YTBOI',
    });

    expect(uri).toContain('otpauth://totp/LXTranslator:jetsada?');
    expect(uri).toContain('secret=MZXW6YTBOI');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    // The label separator has to survive escaping, or the app splits it wrongly.
    expect(uri.split('?')[0].split('/').pop()).toBe('LXTranslator:jetsada');
  });
});

describe('enrolment', () => {
  it('reports no factor before anything is enrolled', async () => {
    const session = await registerAccount(app);

    const response = await request(app)
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);

    expect(response.body.data).toMatchObject({
      enabled: false,
      enrolled: false,
      recovery_codes_remaining: 0,
    });
  });

  it('refuses to start setup without a settings token', async () => {
    const session = await registerAccount(app);

    await request(app)
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: 'not_a_real_token' })
      .expect(401);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/auth/mfa').expect(401);
  });

  it('returns a secret and a URI, then ten recovery codes on confirmation', async () => {
    const session = await registerAccount(app);
    const { recoveryCodes } = await enableSecondFactor(session);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
    }

    const status = await request(app)
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);

    expect(status.body.data).toMatchObject({ enabled: true, recovery_codes_remaining: 10 });
  });

  it('refuses a wrong code at confirmation and leaves the factor off', async () => {
    const session = await registerAccount(app);

    const confirm = await request(app)
      .post('/api/v1/settings/confirm')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: confirm.body.data.token })
      .expect(201);

    const second = await request(app)
      .post('/api/v1/settings/confirm')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: second.body.data.token, code: '000000' })
      .expect(401);

    const status = await request(app)
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);

    // Enrolled but never proved, so a sign in must not be challenged by it.
    expect(status.body.data).toMatchObject({ enabled: false, enrolled: true });
  });

  it('rejects an undeclared field rather than ignoring it', async () => {
    const session = await registerAccount(app);

    await request(app)
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: 'x', account_id: 'someone_else' })
      .expect(422);
  });
});

describe('login challenge', () => {
  it('answers a correct password with a challenge and no session', async () => {
    const session = await registerAccount(app);
    await enableSecondFactor(session);

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    expect(response.body.data.mfa_required).toBe(true);
    expect(response.body.data.challenge_token).toEqual(expect.any(String));
    expect(response.body.data.access_token).toBeUndefined();
    // The email address must not be handed out before the second factor holds.
    expect(response.body.data.account).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(session.account.email);
  });

  it('refuses the challenge token as a bearer credential', async () => {
    const session = await registerAccount(app);
    await enableSecondFactor(session);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.data.challenge_token}`)
      .expect(401);
  });

  it('exchanges a correct code for a session', async () => {
    const session = await registerAccount(app);
    const { secret } = await enableSecondFactor(session);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    const completed = await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({
        challenge_token: login.body.data.challenge_token,
        code: totp.deriveCode(secret, totp.counterAt()),
      })
      .expect(200);

    expect(completed.body.data.access_token).toEqual(expect.any(String));
    expect(completed.body.data.account.user_id).toBe(session.account.user_id);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${completed.body.data.access_token}`)
      .expect(200);
  });

  it('refuses to spend the same code twice inside its own window', async () => {
    const session = await registerAccount(app);
    const { secret } = await enableSecondFactor(session);
    const code = totp.deriveCode(secret, totp.counterAt());

    const first = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: first.body.data.challenge_token, code })
      .expect(200);

    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    // Drift keeps this code current for another minute. Somebody who read it
    // over a shoulder must still not be able to use it.
    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: second.body.data.challenge_token, code })
      .expect(401);
  });

  it('refuses a replayed challenge token', async () => {
    const session = await registerAccount(app);
    const { secret } = await enableSecondFactor(session);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    const challengeToken = login.body.data.challenge_token;

    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: challengeToken, code: totp.deriveCode(secret, totp.counterAt()) })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({
        challenge_token: challengeToken,
        code: totp.deriveCode(secret, totp.counterAt() + 1),
      })
      .expect(401);
  });

  it('draws wrong codes from the same budget as wrong passwords', async () => {
    const session = await registerAccount(app);
    await enableSecondFactor(session);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    const challengeToken = login.body.data.challenge_token;

    // The account allows five failures in total. A second factor with a budget
    // of its own would hand somebody holding the password unlimited guesses.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/login/mfa')
        .send({ challenge_token: challengeToken, code: '000000' })
        .expect(401);
    }

    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(401);

    expect(locked.body.error.message).toMatch(/locked/i);
  });
});

describe('recovery codes', () => {
  it('accepts a recovery code in place of a generated one, exactly once', async () => {
    const session = await registerAccount(app);
    const { recoveryCodes } = await enableSecondFactor(session);
    const [code] = recoveryCodes;

    const first = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    const used = await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: first.body.data.challenge_token, code })
      .expect(200);

    expect(used.body.data.access_token).toEqual(expect.any(String));

    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: second.body.data.challenge_token, code })
      .expect(401);
  });

  it('counts down as codes are spent', async () => {
    const session = await registerAccount(app);
    const { recoveryCodes } = await enableSecondFactor(session);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: login.body.data.challenge_token, code: recoveryCodes[0] })
      .expect(200);

    const status = await request(app)
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);

    expect(status.body.data.recovery_codes_remaining).toBe(9);
  });

  it('replaces every code on regeneration rather than topping them up', async () => {
    const session = await registerAccount(app);
    const { recoveryCodes } = await enableSecondFactor(session);

    const confirm = await request(app)
      .post('/api/v1/settings/confirm')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: VALID_PASSWORD })
      .expect(200);

    const regenerated = await request(app)
      .post('/api/v1/auth/mfa/recovery_codes')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: confirm.body.data.token })
      .expect(200);

    expect(regenerated.body.data.recovery_codes).toHaveLength(10);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    // An old sheet must stop working the moment a new one is printed.
    await request(app)
      .post('/api/v1/auth/login/mfa')
      .send({ challenge_token: login.body.data.challenge_token, code: recoveryCodes[0] })
      .expect(401);
  });
});

describe('removing the factor', () => {
  it('needs a settings token, and then sign in stops being challenged', async () => {
    const session = await registerAccount(app);
    await enableSecondFactor(session);

    await request(app)
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: 'not_a_real_token' })
      .expect(401);

    const confirm = await request(app)
      .post('/api/v1/settings/confirm')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: VALID_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ settings_token: confirm.body.data.token })
      .expect(204);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: VALID_PASSWORD })
      .expect(200);

    expect(login.body.data.access_token).toEqual(expect.any(String));
    expect(login.body.data.mfa_required).toBeUndefined();
  });
});

describe('interaction with a password reset', () => {
  it('leaves the second factor in place', async () => {
    const session = await registerAccount(app);
    await enableSecondFactor(session);

    const forgot = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: session.account.email })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/password/reset')
      .send({
        token: forgot.body.data.development_token,
        password: 'An0therPassphrase',
        confirm_password: 'An0therPassphrase',
      })
      .expect(200);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: session.account.user_id, password: 'An0therPassphrase' })
      .expect(200);

    /*
     * A reset that cleared the second factor would make the factor exactly as
     * strong as the mailbox it was meant to survive. Somebody who takes over
     * the email address still has to produce a code.
     */
    expect(login.body.data.mfa_required).toBe(true);
    expect(login.body.data.access_token).toBeUndefined();
  });
});
