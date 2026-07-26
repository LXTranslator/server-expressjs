'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
} = require('./helpers/testApp');
const { isValidTextHash } = require('../src/core/textHash');

/** A nested locale document, matching how real translation files are written. */
const SOURCE_DOCUMENT = {
  greeting: { hello: 'Hello {name}', farewell: 'Goodbye' },
  actions: { save: 'Save', delete: 'Delete %s' },
};

describe('translation pipeline', () => {
  let app;
  let token;
  let namespace;
  let project;

  beforeAll(async () => {
    app = await setupTestApp();
    const registered = await registerAccount(app, {
      user_id: 'pipeline_user',
      email: 'pipeline@example.test',
    });
    token = registered.token;
    namespace = registered.account.user_id;
    project = await createProject(app, token, namespace);
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  /**
   * Uploads a document and waits for the worker to finish.
   *
   * @param {object} document Locale document.
   * @param {object} [options] Upload options.
   * @returns {Promise<object>} The file in a terminal state.
   */
  async function upload(document, options = {}) {
    const response = await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('source_lang', options.sourceLang ?? 'en_us')
      .field('target_langs', options.targetLangs ?? 'th_th,ja_jp')
      .attach('file', Buffer.from(JSON.stringify(document)), options.filename ?? 'en_us.json')
      .expect(202);

    return waitForFile(app, token, response.body.data.file.id);
  }

  it('processes an English upload into every requested locale', async () => {
    const file = await upload(SOURCE_DOCUMENT, { filename: 'en_us.json' });

    expect(file.status).toBe('READY');
    expect(file.key_count).toBe(4);
    expect(file.target_lang_codes).toEqual(['th_th', 'ja_jp']);

    const editor = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { keys, available_locales: locales } = editor.body.data;

    // Nested keys are flattened to dot notation.
    expect(keys.map((key) => key.key_name).sort()).toEqual([
      'actions.delete',
      'actions.save',
      'greeting.farewell',
      'greeting.hello',
    ]);

    expect(locales.sort()).toEqual(['en_us', 'ja_jp', 'th_th']);

    // Every key carries a well formed 36 character fingerprint.
    for (const key of keys) {
      expect(key.text_hash).toHaveLength(36);
      expect(isValidTextHash(key.text_hash)).toBe(true);
      expect(key.translations).toHaveLength(2);
    }
  });

  it('exports a locale in the documented value and hash shape', async () => {
    const file = await upload(SOURCE_DOCUMENT, { filename: 'export_case.json' });

    const response = await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .query({ lang: 'th_th' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('th_th.json');

    const document = JSON.parse(response.text);

    // Nesting is preserved and each leaf is a value plus its tracking hash.
    expect(document.greeting.hello).toEqual({
      value: expect.any(String),
      hash: expect.any(String),
    });
    expect(document.greeting.hello.hash).toHaveLength(36);

    // The placeholder survives translation intact.
    expect(document.greeting.hello.value).toContain('{name}');
  });

  it('exports every locale at once when no language is named', async () => {
    const file = await upload(SOURCE_DOCUMENT, { filename: 'bundle_case.json' });

    const response = await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const files = response.body.data.files;
    expect(Object.keys(files).sort()).toEqual(['en_us.json', 'ja_jp.json', 'th_th.json']);

    // The master document carries the English source text.
    expect(files['en_us.json'].greeting.hello.value).toBe('Hello {name}');
  });

  it('translates a non English upload into the master first', async () => {
    const file = await upload(
      { hi: 'สวัสดี', bye: 'ลาก่อน' },
      { sourceLang: 'th_th', targetLangs: 'ja_jp', filename: 'th_th.json' },
    );

    expect(file.status).toBe('READY');
    expect(file.source_lang_code).toBe('th_th');

    const editor = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const key = editor.body.data.keys.find((entry) => entry.key_name === 'hi');

    // The uploaded Thai text is retained, and the master text is its English
    // rendering, which is what every other locale is derived from.
    expect(key.source_text).toBe('สวัสดี');
    expect(key.original_text).not.toBe('สวัสดี');
    expect(isValidTextHash(key.text_hash)).toBe(true);
  });

  it('keeps a manual correction and marks it as such', async () => {
    const file = await upload(SOURCE_DOCUMENT, { filename: 'manual_case.json' });

    const editor = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const key = editor.body.data.keys[0];
    const translation = key.translations[0];

    const corrected = await request(app)
      .patch(`/api/v1/files/${file.id}/translations/${translation.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ translated_text: 'A human wrote this' })
      .expect(200);

    expect(corrected.body.data.translation.translated_text).toBe('A human wrote this');
    expect(corrected.body.data.translation.is_manual).toBe(true);
  });

  it('marks translations stale once the master text changes', async () => {
    const file = await upload(SOURCE_DOCUMENT, { filename: 'stale_case.json' });

    const before = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(before.body.data.stale_translations).toHaveLength(0);

    const key = before.body.data.keys.find((entry) => entry.key_name === 'greeting.hello');

    // Editing the English source restamps the fingerprint, which is exactly how
    // a consumer learns its stored translation is out of date.
    const updated = await request(app)
      .patch(`/api/v1/files/${file.id}/keys/${key.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ original_text: 'Hello there, {name}!' })
      .expect(200);

    expect(updated.body.data.key.text_hash).not.toBe(key.text_hash);

    const after = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const stale = after.body.data.stale_translations;
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((entry) => entry.key_name === 'greeting.hello')).toBe(true);
    expect(stale[0].current_hash).not.toBe(stale[0].translated_with_hash);
  });

  it('records a failure on the file when every key is rejected', async () => {
    const failingProject = await createProject(app, token, namespace, {
      name: 'failing_project',
    });

    // Both credentials are failure fixtures, so the fallback chain runs out.
    for (const key of ['mock_key_invalid', 'mock_key_quota_exceeded']) {
      await request(app)
        .post(`/api/v1/projects/${failingProject.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ api_key: key, label: key })
        .expect(201);
    }

    const response = await request(app)
      .post(`/api/v1/projects/${failingProject.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('target_langs', 'th_th')
      .attach('file', Buffer.from(JSON.stringify({ a: 'A' })), 'en_us.json')
      .expect(202);

    const file = await waitForFile(app, token, response.body.data.file.id);

    expect(file.status).toBe('FAILED');
    expect(file.error_message).toMatch(/API key/i);
    // The stored message must not leak any credential material.
    expect(file.error_message).not.toContain('mock_key_invalid');
  });
});
