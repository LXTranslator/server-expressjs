'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
} = require('./helpers/testApp');
const { extractPlaceholders, comparePlaceholders } = require('../src/core/placeholders');

/*
 * Partial updates and the consistency check.
 *
 * Two things are being proved here. First, that correcting one master string
 * touches one key: everything else keeps its fingerprint, and a refresh sends
 * only the keys that were named. Second, that a translation which has drifted
 * structurally away from the master is reported when somebody asks, and never
 * as a side effect of an edit.
 */

describe('placeholder extraction', () => {
  it.each([
    ['single braces', 'Hello {name}', ['{name}']],
    ['double braces', 'You have {{count}} items', ['{{count}}']],
    ['icu plural', '{count, plural, other {#}}', ['{count, plural, other {#}}']],
    ['printf', 'Saved %s at %d', ['%s', '%d']],
    ['positional printf', 'Moved %1$s to %2$s', ['%1$s', '%2$s']],
    ['named printf', 'Hello %(name)s', ['%(name)s']],
    ['markup', 'Read the <b>manual</b>', ['<b>', '</b>']],
    ['self closing markup', 'One<br/>Two', ['<br/>']],
    ['numbered components', 'Go <0>here</0>', ['<0>', '</0>']],
    ['colon prefixed', 'Open :page_id now', [':page_id']],
  ])('finds %s', (_label, text, expected) => {
    expect(extractPlaceholders(text)).toEqual(expected);
  });

  it.each([
    ['a clock time', 'Starts at 12:30 today'],
    ['a URL', 'See https://example.com/a'],
    ['a labelled sentence', 'Note: read this'],
    ['an arithmetic comparison', '5<10 and 20>15'],
    ['an escaped percent', 'Battery at 50%% charge'],
    ['ordinary prose', 'Just some text.'],
  ])('does not mistake %s for a placeholder', (_label, text) => {
    expect(extractPlaceholders(text)).toEqual([]);
  });

  it('counts repeats rather than only presence', () => {
    const result = comparePlaceholders('{name} and {name}', 'เพียง {name}');
    expect(result.missing).toEqual([{ token: '{name}', expected: 2, found: 1 }]);
  });

  it('reports a token the translation invented', () => {
    const result = comparePlaceholders('Hello', 'สวัสดี {name}');
    expect(result.unexpected).toEqual([{ token: '{name}', expected: 0, found: 1 }]);
  });

  it('treats a renamed token as one missing and one unexpected', () => {
    // Which is exactly what it is: the runtime substitutes neither.
    const result = comparePlaceholders('Hello {name}', 'สวัสดี {ชื่อ}');
    expect(result.missing.map((entry) => entry.token)).toEqual(['{name}']);
    expect(result.unexpected.map((entry) => entry.token)).toEqual(['{ชื่อ}']);
  });

  it('is quiet when the two sides agree', () => {
    const result = comparePlaceholders('Hello {name}, you have %d messages', 'Hallo {name}, %d');
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
});

describe('partial updates and consistency', () => {
  let app;
  let token;
  let projectId;
  let file;
  let keys;

  /**
   * Reloads the editor payload for the file under test.
   *
   * @returns {Promise<object>} Editor data.
   */
  async function readEditor() {
    const response = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body.data;
  }

  beforeAll(async () => {
    app = await setupTestApp();
    const registered = await registerAccount(app, {
      user_id: 'consistency_user',
      email: 'consistency@example.test',
    });
    token = registered.token;

    const project = await createProject(app, token, registered.account.user_id);
    projectId = project.id;

    const response = await request(app)
      .post(`/api/v1/projects/${projectId}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('source_lang', 'en_us')
      .field('target_langs', 'th_th,ja_jp')
      .attach(
        'file',
        Buffer.from(
          JSON.stringify({
            greeting: { hello: 'Hello {name}' },
            save: 'Save',
            count: 'You have %d items',
          }),
        ),
        'consistency_case.json',
      )
      .expect(202);

    file = await waitForFile(app, token, response.body.data.file.id);
    keys = (await readEditor()).keys;
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  describe('updating one key', () => {
    it('restamps only the key that was named', async () => {
      const target = keys.find((key) => key.key_name === 'save');
      const untouched = keys.find((key) => key.key_name === 'count');

      const response = await request(app)
        .patch(`/api/v1/files/${file.id}/keys/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ original_text: 'Save changes' })
        .expect(200);

      expect(response.body.data.changed).toBe(true);
      expect(response.body.data.key.text_hash).not.toBe(target.text_hash);

      const after = await readEditor();
      expect(after.keys.find((key) => key.key_name === 'count').text_hash).toBe(
        untouched.text_hash,
      );
    });

    it('reports which languages the edit left behind', async () => {
      const target = keys.find((key) => key.key_name === 'greeting.hello');

      const response = await request(app)
        .patch(`/api/v1/files/${file.id}/keys/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ original_text: 'Hello there, {name}' })
        .expect(200);

      expect(response.body.data.changed).toBe(true);
      expect(response.body.data.stale_lang_codes.sort()).toEqual(['ja_jp', 'th_th']);
    });

    it('reports no change when the text is identical, and restamps nothing', async () => {
      const before = (await readEditor()).keys.find((key) => key.key_name === 'count');

      const response = await request(app)
        .patch(`/api/v1/files/${file.id}/keys/${before.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ original_text: before.original_text })
        .expect(200);

      expect(response.body.data.changed).toBe(false);
      expect(response.body.data.key.text_hash).toBe(before.text_hash);
      expect(response.body.data.stale_lang_codes).toEqual([]);
    });

    it('still reports a key that was left behind by an earlier edit', async () => {
      // `save` was edited above and never refreshed, so writing the same text
      // again changes nothing yet the languages are still behind it. The field
      // describes the key's current state, not this one request.
      const target = (await readEditor()).keys.find((key) => key.key_name === 'save');

      const response = await request(app)
        .patch(`/api/v1/files/${file.id}/keys/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ original_text: target.original_text })
        .expect(200);

      expect(response.body.data.changed).toBe(false);
      expect(response.body.data.stale_lang_codes.sort()).toEqual(['ja_jp', 'th_th']);
    });

    it('refuses a key belonging to another file', async () => {
      const other = await request(app)
        .post(`/api/v1/projects/${projectId}/files`)
        .set('Authorization', `Bearer ${token}`)
        .field('target_langs', 'th_th')
        .attach('file', Buffer.from(JSON.stringify({ other: 'Other' })), 'other_file.json')
        .expect(202);

      const otherFile = await waitForFile(app, token, other.body.data.file.id);
      const otherKeys = (
        await request(app)
          .get(`/api/v1/files/${otherFile.id}/translations`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body.data.keys;

      await request(app)
        .patch(`/api/v1/files/${file.id}/keys/${otherKeys[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ original_text: 'Hijacked' })
        .expect(404);
    });
  });

  describe('retranslating named keys', () => {
    it('refreshes only the keys named, leaving the rest alone', async () => {
      const before = await readEditor();
      const target = before.keys.find((key) => key.key_name === 'greeting.hello');
      const untouched = before.keys.find((key) => key.key_name === 'count');

      const untouchedTexts = untouched.translations.map((entry) => entry.translated_text).sort();

      await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ key_ids: [target.id] })
        .expect(202);

      await waitForFile(app, token, file.id);
      const after = await readEditor();

      // The named key caught up with its master.
      const refreshed = after.keys.find((key) => key.key_name === 'greeting.hello');
      expect(
        refreshed.translations.every((entry) => entry.source_hash === refreshed.text_hash),
      ).toBe(true);
      expect(
        after.stale_translations.some((entry) => entry.key_name === 'greeting.hello'),
      ).toBe(false);

      // Everything else came back byte for byte, so nothing was resent.
      const afterUntouched = after.keys.find((key) => key.key_name === 'count');
      expect(afterUntouched.translations.map((entry) => entry.translated_text).sort()).toEqual(
        untouchedTexts,
      );
    });

    it('accepts a subset of the languages on the file', async () => {
      const target = (await readEditor()).keys.find((key) => key.key_name === 'save');

      const response = await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ key_ids: [target.id], target_langs: ['th_th'] })
        .expect(202);

      expect(response.body.data.target_langs).toEqual(['th_th']);
      expect(response.body.data.keys).toEqual([{ id: target.id, key_name: 'save' }]);
      await waitForFile(app, token, file.id);
    });

    it('refuses a key that belongs to another file', async () => {
      await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ key_ids: ['11111111-1111-4111-8111-111111111111'] })
        .expect(404);
    });

    it('refuses a language the file does not carry', async () => {
      const target = (await readEditor()).keys[0];

      await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ key_ids: [target.id], target_langs: ['ko_kr'] })
        .expect(400);
    });

    it('refuses an empty selection rather than refreshing everything', async () => {
      await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ key_ids: [] })
        .expect(422);
    });

    it('refuses an undeclared field in the payload', async () => {
      const target = (await readEditor()).keys[0];

      await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ key_ids: [target.id], file_id: 'somebody_elses_file' })
        .expect(422);
    });
  });

  describe('the consistency check', () => {
    let checkFile;

    /**
     * Reloads the editor payload for the file this block owns.
     *
     * @returns {Promise<object>} Editor data.
     */
    async function readCheck() {
      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/translations`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return response.body.data;
    }

    beforeAll(async () => {
      // A file of its own, because the blocks above deliberately leave keys
      // behind their masters and a report over those would prove nothing.
      const response = await request(app)
        .post(`/api/v1/projects/${projectId}/files`)
        .set('Authorization', `Bearer ${token}`)
        .field('source_lang', 'en_us')
        .field('target_langs', 'th_th,ja_jp')
        .attach(
          'file',
          Buffer.from(
            JSON.stringify({
              greeting: { hello: 'Hello {name}' },
              save: 'Save',
              count: 'You have %d items',
            }),
          ),
          'check_case.json',
        )
        .expect(202);

      checkFile = await waitForFile(app, token, response.body.data.file.id);
    });

    it('is clean for a file the pipeline produced', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const report = response.body.data;
      expect(report.consistent).toBe(true);
      expect(report.issue_count).toBe(0);
      expect(report.issues).toEqual([]);
      expect(report.truncated).toBe(false);
      expect(report.master_lang_code).toBe('en_us');
      expect(report.checked_lang_codes.sort()).toEqual(['ja_jp', 'th_th']);
      expect(report.checked_key_count).toBe(3);
    });

    it('carries the placeholders through the mock provider untouched', async () => {
      // The clean report above only means something if the strings really do
      // hold placeholders on both sides.
      const key = (await readCheck()).keys.find((entry) => entry.key_name === 'greeting.hello');
      expect(key.original_text).toContain('{name}');
      expect(key.translations.every((entry) => entry.translated_text.includes('{name}'))).toBe(
        true,
      );
    });

    it('runs only when asked, so an edit does not pay for it', async () => {
      // An edit that breaks a placeholder answers in the ordinary shape and
      // says nothing about consistency; the report is a separate request.
      const key = (await readCheck()).keys.find((entry) => entry.key_name === 'greeting.hello');
      const thai = key.translations.find((entry) => entry.lang_code === 'th_th');

      const response = await request(app)
        .patch(`/api/v1/files/${checkFile.id}/translations/${thai.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ translated_text: 'สวัสดี {ชื่อ}' })
        .expect(200);

      expect(Object.keys(response.body.data)).toEqual(['translation']);
    });

    it('reports a placeholder a reviewer typed in their own language', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const report = response.body.data;
      expect(report.consistent).toBe(false);

      const missing = report.issues.find((issue) => issue.kind === 'PLACEHOLDER_MISSING');
      expect(missing).toMatchObject({
        key_name: 'greeting.hello',
        lang_code: 'th_th',
        token: '{name}',
        expected_count: 1,
        found_count: 0,
      });

      expect(
        report.issues.some(
          (issue) => issue.kind === 'PLACEHOLDER_UNEXPECTED' && issue.token === '{ชื่อ}',
        ),
      ).toBe(true);
    });

    it('narrows to one language when asked, leaving the broken one out', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .query({ lang: 'ja_jp' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.data.checked_lang_codes).toEqual(['ja_jp']);
      expect(response.body.data.consistent).toBe(true);
    });

    it('reports an empty translation against a master that has text', async () => {
      const key = (await readCheck()).keys.find((entry) => entry.key_name === 'save');
      const japanese = key.translations.find((entry) => entry.lang_code === 'ja_jp');

      await request(app)
        .patch(`/api/v1/files/${checkFile.id}/translations/${japanese.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ translated_text: '   ' })
        .expect(200);

      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .query({ lang: 'ja_jp' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        response.body.data.issues.some(
          (issue) => issue.kind === 'EMPTY_TRANSLATION' && issue.key_name === 'save',
        ),
      ).toBe(true);
    });

    it('reports a master edited after its translations were written', async () => {
      const key = (await readCheck()).keys.find((entry) => entry.key_name === 'count');

      await request(app)
        .patch(`/api/v1/files/${checkFile.id}/keys/${key.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ original_text: 'You now have %d items' })
        .expect(200);

      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        response.body.data.issues.filter(
          (issue) => issue.kind === 'STALE_TRANSLATION' && issue.key_name === 'count',
        ),
      ).toHaveLength(2);
    });

    it('refuses a locale the file does not carry', async () => {
      await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .query({ lang: 'ko_kr' })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('refuses an undeclared query field', async () => {
      await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .query({ lang: 'th_th', deep: 'true' })
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });

    it('reports a language listed on the file but not yet produced', async () => {
      await request(app)
        .post(`/api/v1/files/${checkFile.id}/languages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ target_langs: ['ko_kr'] })
        .expect(202);

      // Read the report before the worker finishes, which is the state a locale
      // is in between being requested and being produced.
      const response = await request(app)
        .get(`/api/v1/files/${checkFile.id}/consistency`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.data.checked_lang_codes).toContain('ko_kr');
      await waitForFile(app, token, checkFile.id);
    });
  });

  describe('access', () => {
    let outsiderToken;

    beforeAll(async () => {
      const registered = await registerAccount(app, {
        user_id: 'consistency_outsider',
        email: 'consistency_outsider@example.test',
      });
      outsiderToken = registered.token;
    });

    it('hides the consistency report from another account', async () => {
      await request(app)
        .get(`/api/v1/files/${file.id}/consistency`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(404);
    });

    it('hides the retranslate endpoint from another account', async () => {
      await request(app)
        .post(`/api/v1/files/${file.id}/keys/retranslate`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ key_ids: ['11111111-1111-4111-8111-111111111111'] })
        .expect(404);
    });
  });
});
