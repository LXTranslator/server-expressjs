'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
} = require('./helpers/testApp');

/*
 * Growing a file after it exists.
 *
 * A locale set is not written once. Languages get added, keys get added, and
 * both must leave what is already there alone: an existing translation, and
 * especially a reviewed one, must survive every later addition.
 */

/** The document a file starts from. */
const INITIAL = {
  greeting: { hello: 'Hello {name}' },
  actions: { save: 'Save' },
};

/** The same document with two keys added and one existing value altered. */
const DROPPED = {
  greeting: { hello: 'THIS MUST BE IGNORED', farewell: 'Goodbye' },
  actions: { save: 'ALSO IGNORED', delete: 'Delete %s' },
};

describe('growing a file', () => {
  let app;
  let token;
  let namespace;
  let project;

  beforeAll(async () => {
    app = await setupTestApp();
    const registered = await registerAccount(app, {
      user_id: 'growth_user',
      email: 'growth@example.test',
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
   * @param {string} filename Name to store it under.
   * @param {string} [targetLangs] Comma separated locales.
   * @returns {Promise<object>} The file in a terminal state.
   */
  async function upload(document, filename, targetLangs = 'th_th') {
    const response = await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('source_lang', 'en_us')
      .field('target_langs', targetLangs)
      .attach('file', Buffer.from(JSON.stringify(document)), filename)
      .expect(202);

    return waitForFile(app, token, response.body.data.file.id);
  }

  /**
   * Reads the editor payload for a file.
   *
   * @param {string} fileId File identifier.
   * @returns {Promise<object>} Editor data.
   */
  async function editorData(fileId) {
    const response = await request(app)
      .get(`/api/v1/files/${fileId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body.data;
  }

  describe('adding languages', () => {
    it('translates the existing keys into the new locale only', async () => {
      const file = await upload(INITIAL, 'add_lang.json');
      const before = await editorData(file.id);
      expect(before.available_locales.sort()).toEqual(['en_us', 'th_th']);

      const response = await request(app)
        .post(`/api/v1/files/${file.id}/languages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target_langs: ['ja_jp', 'ko_kr'] })
        .expect(202);

      expect(response.body.data.added.sort()).toEqual(['ja_jp', 'ko_kr']);
      await waitForFile(app, token, file.id);

      const after = await editorData(file.id);
      expect(after.available_locales.sort()).toEqual(['en_us', 'ja_jp', 'ko_kr', 'th_th']);

      // Every key gained the new locales, and the key count did not move.
      expect(after.keys).toHaveLength(before.keys.length);
      for (const key of after.keys) {
        const locales = key.translations.map((entry) => entry.lang_code).sort();
        expect(locales).toEqual(['ja_jp', 'ko_kr', 'th_th']);
      }
    });

    it('leaves a reviewed translation in an existing locale untouched', async () => {
      const file = await upload(INITIAL, 'add_lang_manual.json');
      const before = await editorData(file.id);

      const target = before.keys[0].translations.find((entry) => entry.lang_code === 'th_th');
      await request(app)
        .patch(`/api/v1/files/${file.id}/translations/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ translated_text: 'a reviewed value' })
        .expect(200);

      await request(app)
        .post(`/api/v1/files/${file.id}/languages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target_langs: ['ja_jp'] })
        .expect(202);
      await waitForFile(app, token, file.id);

      const after = await editorData(file.id);
      const reviewed = after.keys
        .find((key) => key.id === before.keys[0].id)
        .translations.find((entry) => entry.lang_code === 'th_th');

      expect(reviewed.translated_text).toBe('a reviewed value');
      expect(reviewed.is_manual).toBe(true);
    });

    it('refuses a language the file already has', async () => {
      const file = await upload(INITIAL, 'add_lang_duplicate.json');

      await request(app)
        .post(`/api/v1/files/${file.id}/languages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target_langs: ['th_th'] })
        .expect(400);
    });

    it('rejects a malformed locale code', async () => {
      const file = await upload(INITIAL, 'add_lang_invalid.json');

      await request(app)
        .post(`/api/v1/files/${file.id}/languages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target_langs: ['../../etc/passwd'] })
        .expect(422);
    });

    it('rejects an undeclared field', async () => {
      const file = await upload(INITIAL, 'add_lang_strict.json');

      await request(app)
        .post(`/api/v1/files/${file.id}/languages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target_langs: ['ja_jp'], status: 'READY' })
        .expect(422);
    });
  });

  describe('merging a dropped document', () => {
    it('adds the missing keys and skips the ones already held', async () => {
      const file = await upload(INITIAL, 'merge.json');
      const before = await editorData(file.id);
      expect(before.keys.map((key) => key.key_name).sort()).toEqual([
        'actions.save',
        'greeting.hello',
      ]);

      const response = await request(app)
        .post(`/api/v1/files/${file.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(JSON.stringify(DROPPED)), 'more_keys.json')
        .expect(202);

      expect(response.body.data.existing_key_count).toBe(2);
      await waitForFile(app, token, file.id);

      const after = await editorData(file.id);
      expect(after.keys.map((key) => key.key_name).sort()).toEqual([
        'actions.delete',
        'actions.save',
        'greeting.farewell',
        'greeting.hello',
      ]);

      // The two keys that already existed keep their master text, even though
      // the dropped document carried a different value for both.
      const hello = after.keys.find((key) => key.key_name === 'greeting.hello');
      const save = after.keys.find((key) => key.key_name === 'actions.save');
      expect(hello.original_text).toBe('Hello {name}');
      expect(save.original_text).toBe('Save');

      // The new keys arrive translated into the file's existing locales.
      const farewell = after.keys.find((key) => key.key_name === 'greeting.farewell');
      expect(farewell.original_text).toBe('Goodbye');
      expect(farewell.translations.map((entry) => entry.lang_code)).toEqual(['th_th']);
    });

    it('keeps the file key count in step with what it holds', async () => {
      const file = await upload(INITIAL, 'merge_count.json');
      expect(file.key_count).toBe(2);

      await request(app)
        .post(`/api/v1/files/${file.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(JSON.stringify(DROPPED)), 'more_keys.json')
        .expect(202);

      // A merge run carries only the keys it adds, so a count taken from the
      // run rather than from the file would report 2 instead of 4.
      const merged = await waitForFile(app, token, file.id);
      expect(merged.key_count).toBe(4);
    });

    it('preserves a reviewed translation on a key the document repeats', async () => {
      const file = await upload(INITIAL, 'merge_manual.json');
      const before = await editorData(file.id);

      const hello = before.keys.find((key) => key.key_name === 'greeting.hello');
      const target = hello.translations.find((entry) => entry.lang_code === 'th_th');
      await request(app)
        .patch(`/api/v1/files/${file.id}/translations/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ translated_text: 'reviewed hello' })
        .expect(200);

      await request(app)
        .post(`/api/v1/files/${file.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(JSON.stringify(DROPPED)), 'more_keys.json')
        .expect(202);
      await waitForFile(app, token, file.id);

      const after = await editorData(file.id);
      const reviewedAfter = after.keys
        .find((key) => key.key_name === 'greeting.hello')
        .translations.find((entry) => entry.lang_code === 'th_th');

      expect(reviewedAfter.translated_text).toBe('reviewed hello');
    });

    it('accepts a document with nothing new and changes nothing', async () => {
      const file = await upload(INITIAL, 'merge_nothing.json');

      await request(app)
        .post(`/api/v1/files/${file.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(JSON.stringify(INITIAL)), 'same_again.json')
        .expect(202);

      const after = await waitForFile(app, token, file.id);
      expect(after.status).toBe('READY');
      expect(after.key_count).toBe(2);
    });

    it('refuses a document that is not JSON', async () => {
      const file = await upload(INITIAL, 'merge_invalid.json');

      await request(app)
        .post(`/api/v1/files/${file.id}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('not json at all'), 'broken.json')
        .expect(400);
    });

    it('refuses a merge into another account file', async () => {
      const file = await upload(INITIAL, 'merge_access.json');
      const outsider = await registerAccount(app, {
        user_id: 'growth_outsider',
        email: 'growth_outsider@example.test',
      });

      await request(app)
        .post(`/api/v1/files/${file.id}/keys`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .attach('file', Buffer.from(JSON.stringify(DROPPED)), 'more_keys.json')
        .expect(404);
    });
  });
});
