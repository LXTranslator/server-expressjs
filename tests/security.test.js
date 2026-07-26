'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
} = require('./helpers/testApp');
const { sanitizeFilename, resolveWithinDirectory } = require('../src/core/filename');
const { encryptSecret, decryptSecret, maskSecret } = require('../src/infrastructure/crypto/secretBox');
const { computeTextHash, isValidTextHash } = require('../src/core/textHash');
const { flattenTranslationTree, expandTranslationTree } = require('../src/core/jsonTree');
const { translateWithKeyFallback } = require('../src/infrastructure/ai/keyFallback');
const logger = require('../src/core/logger');

/**
 * One application and one database connection for the whole file.
 *
 * Sequelize cannot reopen a closed connection manager, so the connection is
 * established once here and released once at the end rather than per describe.
 */
let sharedApp;

beforeAll(async () => {
  sharedApp = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp();
});

describe('security primitives', () => {
  describe('filename sanitisation', () => {
    const rules = { allowedExtensions: ['.json'], maxLength: 128 };

    it('accepts ordinary locale filenames', () => {
      expect(sanitizeFilename('en_us.json', rules)).toBe('en_us.json');
      expect(sanitizeFilename('en-us.json', rules)).toBe('en-us.json');
      expect(sanitizeFilename('my file.json', rules)).toBe('my file.json');
    });

    it('strips traversal sequences down to a bare name', () => {
      expect(sanitizeFilename('../../etc/passwd.json', rules)).toBe('passwd.json');
      expect(sanitizeFilename('..\\..\\windows\\evil.json', rules)).toBe('evil.json');
      expect(sanitizeFilename('/absolute/path.json', rules)).toBe('path.json');
    });

    it('never returns a name containing a separator or traversal', () => {
      const hostile = [
        '../../etc/passwd.json',
        '..\\evil.json',
        '/etc/shadow.json',
        './../../x.json',
      ];
      for (const name of hostile) {
        const safe = sanitizeFilename(name, rules);
        expect(safe).not.toContain('/');
        expect(safe).not.toContain('\\');
        expect(safe).not.toContain('..');
      }
    });

    it('rejects a non JSON extension', () => {
      expect(() => sanitizeFilename('payload.txt', rules)).toThrow(/Only .json/);
      expect(() => sanitizeFilename('shell.json.sh', rules)).toThrow(/Only .json/);
    });

    it('rejects a null byte', () => {
      expect(() => sanitizeFilename('evil\u0000.json', rules)).toThrow(/illegal character/);
    });

    it('rejects a hidden file and a reserved device name', () => {
      expect(() => sanitizeFilename('.hidden.json', rules)).toThrow(/illegal character/);
      expect(() => sanitizeFilename('con.json', rules)).toThrow(/reserved/);
    });

    it('rejects an over long name', () => {
      expect(() => sanitizeFilename(`${'a'.repeat(200)}.json`, rules)).toThrow(/128 characters/);
    });
  });

  describe('path containment', () => {
    it('accepts a path inside the root', () => {
      expect(resolveWithinDirectory('/data/storage', 'file.json')).toBe('/data/storage/file.json');
    });

    it('rejects an escape via traversal', () => {
      expect(() => resolveWithinDirectory('/data/storage', '../../etc/passwd')).toThrow(
        /outside the storage directory/,
      );
    });

    it('rejects a sibling directory sharing the prefix', () => {
      // A naive prefix check would wrongly accept this.
      expect(() => resolveWithinDirectory('/data/storage', '/data/storage_evil/x')).toThrow(
        /outside the storage directory/,
      );
    });
  });

  describe('secret encryption', () => {
    it('round trips a value', () => {
      const secret = 'sk_live_abcdef1234567890';
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    });

    it('never stores the plaintext', () => {
      const secret = 'sk_live_abcdef1234567890';
      expect(encryptSecret(secret)).not.toContain(secret);
    });

    it('produces a different envelope every time', () => {
      // A fresh initialisation vector per message means identical secrets do
      // not produce identical ciphertext.
      const secret = 'sk_live_abcdef1234567890';
      expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
    });

    it('refuses a tampered envelope', () => {
      const envelope = encryptSecret('sk_live_abcdef1234567890');
      const parts = envelope.split(':');
      const flipped = Buffer.from(parts[3], 'base64url');
      flipped[0] ^= 0xff;
      parts[3] = flipped.toString('base64url');

      // Authenticated encryption fails closed rather than returning garbage.
      expect(() => decryptSecret(parts.join(':'))).toThrow();
    });

    it('masks a value down to its last four characters', () => {
      expect(maskSecret('sk_live_abcdef1234567890')).toMatch(/^\*+7890$/);
    });
  });

  describe('text hash', () => {
    it('is exactly 36 characters and canonically formed', () => {
      const hash = computeTextHash('Hello world');
      expect(hash).toHaveLength(36);
      expect(isValidTextHash(hash)).toBe(true);
    });

    it('is deterministic', () => {
      expect(computeTextHash('Hello')).toBe(computeTextHash('Hello'));
    });

    it('changes when the source text changes', () => {
      expect(computeTextHash('Hello')).not.toBe(computeTextHash('Hello!'));
    });
  });

  describe('json tree handling', () => {
    it('flattens nested keys to dot notation', () => {
      const leaves = flattenTranslationTree(
        { a: { b: { c: 'deep' } }, top: 'value' },
        { maxDepth: 10, maxKeys: 100 },
      );
      expect(leaves.map((leaf) => leaf.keyName).sort()).toEqual(['a.b.c', 'top']);
    });

    it('refuses a prototype polluting key', () => {
      expect(() =>
        flattenTranslationTree({ __proto__: { evil: 'x' }, ok: 'y' }, { maxDepth: 10, maxKeys: 10 }),
      ).not.toThrow();

      // The dangerous case is a literal key, which JSON.parse preserves.
      const parsed = JSON.parse('{"constructor": {"a": "b"}}');
      expect(() => flattenTranslationTree(parsed, { maxDepth: 10, maxKeys: 10 })).toThrow(
        /not allowed/,
      );
    });

    it('does not pollute Object.prototype when expanding', () => {
      const parsed = JSON.parse('[{"keyName": "safe.key", "value": "ok"}]');
      expandTranslationTree(parsed);
      expect({}.polluted).toBeUndefined();
    });

    it('enforces the depth and key ceilings', () => {
      expect(() =>
        flattenTranslationTree({ a: { b: { c: 'x' } } }, { maxDepth: 2, maxKeys: 100 }),
      ).toThrow(/nests deeper/);

      expect(() =>
        flattenTranslationTree({ a: '1', b: '2', c: '3' }, { maxDepth: 10, maxKeys: 2 }),
      ).toThrow(/more than 2/);
    });

    it('rejects a non object root', () => {
      expect(() => flattenTranslationTree([1, 2], { maxDepth: 5, maxKeys: 5 })).toThrow(
        /JSON object at its root/,
      );
    });
  });

  describe('log redaction', () => {
    it('replaces sensitive field values', () => {
      const redacted = logger.redact({
        email: 'user@example.test',
        password: 'secret_value',
        api_key: 'sk_live_123',
        nested: { authorization: 'Bearer abc', safe: 'keep' },
      });

      expect(redacted.email).toBe('user@example.test');
      expect(redacted.password).toBe('[redacted]');
      expect(redacted.api_key).toBe('[redacted]');
      expect(redacted.nested.authorization).toBe('[redacted]');
      expect(redacted.nested.safe).toBe('keep');
    });
  });

  describe('api key fallback', () => {
    it('moves to the next credential when one is revoked', async () => {
      const result = await translateWithKeyFallback({
        providerName: 'mock',
        model: 'mock-small',
        keys: [
          { id: 'k1', apiKey: 'mock_key_invalid' },
          { id: 'k2', apiKey: 'working_key' },
        ],
        sourceLang: 'en_us',
        targetLang: 'th_th',
        texts: ['Hello'],
      });

      expect(result.keyId).toBe('k2');
      expect(result.translations).toHaveLength(1);
    });

    it('walks the whole chain in priority order', async () => {
      const result = await translateWithKeyFallback({
        providerName: 'mock',
        model: 'mock-small',
        keys: [
          { id: 'k1', apiKey: 'mock_key_invalid' },
          { id: 'k2', apiKey: 'mock_key_rate_limited' },
          { id: 'k3', apiKey: 'mock_key_quota_exceeded' },
          { id: 'k4', apiKey: 'working_key' },
        ],
        sourceLang: 'en_us',
        targetLang: 'th_th',
        texts: ['Hello'],
      });

      expect(result.keyId).toBe('k4');
      expect(result.attempts.filter((a) => a.outcome === 'FAILED')).toHaveLength(3);
    });

    it('fails when every credential is rejected', async () => {
      await expect(
        translateWithKeyFallback({
          providerName: 'mock',
          model: 'mock-small',
          keys: [
            { id: 'k1', apiKey: 'mock_key_invalid' },
            { id: 'k2', apiKey: 'mock_key_quota_exceeded' },
          ],
          sourceLang: 'en_us',
          targetLang: 'th_th',
          texts: ['Hello'],
        }),
      ).rejects.toThrow(/Every configured API key failed/);
    });

    it('fails immediately when no credential is configured', async () => {
      await expect(
        translateWithKeyFallback({
          providerName: 'mock',
          model: 'mock-small',
          keys: [],
          sourceLang: 'en_us',
          targetLang: 'th_th',
          texts: ['Hello'],
        }),
      ).rejects.toThrow(/no active API key/);
    });

    it('rejects an unknown provider rather than guessing an endpoint', async () => {
      await expect(
        translateWithKeyFallback({
          providerName: 'https://attacker.example',
          model: 'x',
          keys: [{ id: 'k1', apiKey: 'k' }],
          sourceLang: 'en_us',
          targetLang: 'th_th',
          texts: ['Hello'],
        }),
      ).rejects.toThrow(/not supported/);
    });
  });
});

describe('upload endpoint hardening', () => {
  let app;
  let token;
  let project;

  beforeAll(async () => {
    app = sharedApp;
    const registered = await registerAccount(app, {
      user_id: 'upload_user',
      email: 'upload@example.test',
    });
    token = registered.token;
    project = await createProject(app, token, 'upload_user');
  });

  /**
   * Posts an upload with the given attachment.
   *
   * @param {Buffer} buffer File bytes.
   * @param {string} filename Client supplied name.
   * @param {string} [contentType] Client supplied content type.
   * @returns {import('supertest').Test} The pending request.
   */
  function upload(buffer, filename, contentType = 'application/json') {
    return request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('target_langs', 'th_th')
      .attach('file', buffer, { filename, contentType });
  }

  it('rejects a non JSON extension', async () => {
    const response = await upload(Buffer.from('{"a":"b"}'), 'payload.txt', 'text/plain');
    expect(response.status).toBe(400);
  });

  it('rejects a disallowed content type', async () => {
    const response = await upload(Buffer.from('{"a":"b"}'), 'payload.json', 'image/png');
    expect(response.status).toBe(415);
  });

  it('rejects a file whose bytes are not JSON', async () => {
    const response = await upload(Buffer.from('not json at all'), 'broken.json');
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/not valid JSON/);
  });

  it('rejects a JSON array at the root', async () => {
    const response = await upload(Buffer.from('["a","b"]'), 'array.json');
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/JSON object at its root/);
  });

  it('rejects a file above the size limit', async () => {
    const huge = Buffer.from(JSON.stringify({ big: 'x'.repeat(3 * 1024 * 1024) }));
    const response = await upload(huge, 'huge.json');
    expect(response.status).toBe(413);
  });

  it('neutralises a traversal filename instead of writing outside storage', async () => {
    const response = await upload(Buffer.from('{"a":"A"}'), '../../../etc/passwd.json');
    expect(response.status).toBe(202);
    // The stored name is the bare basename, with the traversal removed.
    expect(response.body.data.file.filename).toBe('passwd.json');
  });

  it('rejects an unknown locale code', async () => {
    const response = await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('target_langs', '../../etc')
      .attach('file', Buffer.from('{"a":"A"}'), 'locale.json');

    expect(response.status).toBe(422);
  });

  it('requires authentication', async () => {
    await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .field('target_langs', 'th_th')
      .attach('file', Buffer.from('{"a":"A"}'), 'en_us.json')
      .expect(401);
  });
});

describe('credential exposure', () => {
  let app;
  let token;
  let project;

  beforeAll(async () => {
    app = sharedApp;
    const registered = await registerAccount(app, {
      user_id: 'keys_user',
      email: 'keys@example.test',
    });
    token = registered.token;
    project = await createProject(app, token, 'keys_user');
  });

  it('never returns a stored key in any response', async () => {
    const secret = 'sk_live_supersecret_value_9876';

    const created = await request(app)
      .post(`/api/v1/projects/${project.id}/keys`)
      .set('Authorization', `Bearer ${token}`)
      .send({ api_key: secret, label: 'primary' })
      .expect(201);

    expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(created.body.data.key.masked_key).toBe('****9876');

    const listed = await request(app)
      .get(`/api/v1/projects/${project.id}/keys`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(JSON.stringify(listed.body)).not.toContain(secret);
  });

  it('stores the key encrypted rather than in the clear', async () => {
    const secret = 'sk_live_another_secret_5432';

    await request(app)
      .post(`/api/v1/projects/${project.id}/keys`)
      .set('Authorization', `Bearer ${token}`)
      .send({ api_key: secret })
      .expect(201);

    const { ProjectApiKey } = require('../src/infrastructure/database/models');
    const row = await ProjectApiKey.scope('withSecret').findOne({
      where: { projectId: project.id, lastFour: '5432' },
    });

    expect(row.apiKey).not.toContain(secret);
    expect(row.apiKey.startsWith('v1:')).toBe(true);
    expect(decryptSecret(row.apiKey)).toBe(secret);
  });

  it('leaves the encrypted column out of a query that does not ask for it', async () => {
    // The scope is the defence that makes a generic findAll safe by default,
    // and it only works if it names the attribute rather than the column.
    const { ProjectApiKey } = require('../src/infrastructure/database/models');

    const row = await ProjectApiKey.findOne({ where: { projectId: project.id } });

    expect(row.apiKey).toBeUndefined();
    expect(Object.keys(row.toJSON())).not.toContain('apiKey');
    expect(Object.keys(row.toJSON())).not.toContain('api_key');
  });

  it('keeps priority order for the fallback chain', async () => {
    const fresh = await createProject(app, token, 'keys_user', { name: 'ordered_project' });

    for (const label of ['first', 'second', 'third']) {
      await request(app)
        .post(`/api/v1/projects/${fresh.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ api_key: `sk_${label}_000`, label })
        .expect(201);
    }

    const listed = await request(app)
      .get(`/api/v1/projects/${fresh.id}/keys`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(listed.body.data.keys.map((key) => key.priority_order)).toEqual([1, 2, 3]);

    // Reordering rewrites the chain the worker will walk.
    const reversed = [...listed.body.data.keys].reverse().map((key) => key.id);
    const reordered = await request(app)
      .post(`/api/v1/projects/${fresh.id}/keys/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ordered_key_ids: reversed })
      .expect(200);

    expect(reordered.body.data.keys.map((key) => key.label)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });
});
