'use strict';

const zlib = require('node:zlib');
const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
} = require('./helpers/testApp');
const { crc32 } = require('../src/core/zip');

/*
 * Export formats.
 *
 * A format belongs to a namespace, not to a project, so the interesting cases
 * are the boundary ones: a format created in one namespace must not be visible
 * or usable in another, the two built in shapes must exist everywhere without
 * anybody creating them, and neither may be edited away underneath a consumer
 * that already downloads with it.
 */

/** End of central directory signature. */
const SIGNATURE_END = 0x06054b50;

/**
 * Reads a ZIP archive the way an extractor does.
 *
 * @param {Buffer} archive Complete archive bytes.
 * @returns {Record<string, string>} Entry contents keyed by name.
 * @throws {Error} When the archive is malformed.
 */
function readZipArchive(archive) {
  let end = -1;
  for (let index = archive.length - 22; index >= 0; index -= 1) {
    if (archive.readUInt32LE(index) === SIGNATURE_END) {
      end = index;
      break;
    }
  }
  if (end === -1) throw new Error('No end of central directory record.');

  const total = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries = {};

  for (let index = 0; index < total; index += 1) {
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(stored) : stored;

    if (crc32(content) !== expectedCrc) {
      throw new Error(`Checksum mismatch for ${name}.`);
    }

    entries[name] = content.toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Downloads a response body as raw bytes rather than letting supertest parse it.
 *
 * @param {import('supertest').Test} pending Request under construction.
 * @returns {import('supertest').Test} The same request, configured.
 */
function asBuffer(pending) {
  return pending.buffer().parse((res, callback) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });
}

describe('export formats', () => {
  let app;
  let token;
  let namespace;
  let file;

  beforeAll(async () => {
    app = await setupTestApp();
    const registered = await registerAccount(app, {
      user_id: 'format_user',
      email: 'format@example.test',
    });
    token = registered.token;
    namespace = registered.account.user_id;

    const project = await createProject(app, token, namespace);

    const response = await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('source_lang', 'en_us')
      .field('target_langs', 'th_th')
      .attach(
        'file',
        Buffer.from(JSON.stringify({ greeting: { hello: 'Hello' }, save: 'Save' })),
        'format_case.json',
      )
      .expect(202);

    file = await waitForFile(app, token, response.body.data.file.id);
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  describe('catalogue', () => {
    it('offers every built in format to a namespace that created none', async () => {
      const response = await request(app)
        .get(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const formats = response.body.data.export_formats;
      expect(formats.map((format) => format.format_id)).toEqual([
        'default',
        'key_value',
        'flat_key_value',
      ]);
      expect(formats.every((format) => format.built_in)).toBe(true);
    });

    it('offers the same catalogue through the file being downloaded', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.data.export_formats.map((format) => format.format_id)).toEqual([
        'default',
        'key_value',
        'flat_key_value',
      ]);
    });
  });

  describe('default format', () => {
    it('keeps the value and hash shape when no format is named', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const document = JSON.parse(response.text);
      expect(document.greeting.hello).toEqual({
        value: expect.stringContaining('Hello'),
        hash: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    });

    it('produces the same document when the format is named explicitly', async () => {
      const implicit = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const explicit = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'default' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(JSON.parse(explicit.text)).toEqual(JSON.parse(implicit.text));
    });
  });

  describe('key_value format', () => {
    it('emits the translated string directly, with nesting preserved', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'key_value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const document = JSON.parse(response.text);
      expect(typeof document.greeting.hello).toBe('string');
      expect(document.greeting.hello).toContain('Hello');
      expect(typeof document.save).toBe('string');
    });

    it('carries no fingerprint anywhere in the document', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'key_value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.text).not.toContain('hash');
    });

    it('applies to the whole archive', async () => {
      const response = await asBuffer(
        request(app)
          .get(`/api/v1/files/${file.id}/download`)
          .query({ format: 'zip', export_format: 'key_value' })
          .set('Authorization', `Bearer ${token}`),
      ).expect(200);

      // The archive keeps its fixed name whatever shape the documents take, so
      // a build script that fetches langs.zip is unaffected by the choice.
      expect(response.headers['content-disposition']).toBe('attachment; filename="langs.zip"');

      const entries = readZipArchive(response.body);
      expect(Object.keys(entries).sort()).toEqual(['en_us.json', 'th_th.json']);
      expect(typeof JSON.parse(entries['th_th.json']).greeting.hello).toBe('string');
      expect(typeof JSON.parse(entries['en_us.json']).save).toBe('string');
    });

    it('applies to the editor envelope that names no locale', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ export_format: 'key_value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(typeof response.body.data.files['en_us.json'].save).toBe('string');
    });
  });

  describe('flat_key_value format', () => {
    it('keeps the dotted path as a single key rather than nesting it', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'flat_key_value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const document = JSON.parse(response.text);
      expect(typeof document['greeting.hello']).toBe('string');
      expect(document['greeting.hello']).toContain('Hello');
      // The nesting the upload had must be gone, not merely duplicated.
      expect(document.greeting).toBeUndefined();
    });

    it('leaves a key that never had a path alone', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'flat_key_value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(typeof JSON.parse(response.text).save).toBe('string');
    });

    it('carries no fingerprint anywhere in the document', async () => {
      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'flat_key_value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.text).not.toContain('hash');
    });

    it('applies to every document in the archive', async () => {
      const response = await asBuffer(
        request(app)
          .get(`/api/v1/files/${file.id}/download`)
          .query({ format: 'zip', export_format: 'flat_key_value' })
          .set('Authorization', `Bearer ${token}`),
      ).expect(200);

      const entries = readZipArchive(response.body);
      expect(Object.keys(entries).sort()).toEqual(['en_us.json', 'th_th.json']);
      expect(typeof JSON.parse(entries['th_th.json'])['greeting.hello']).toBe('string');
      expect(JSON.parse(entries['en_us.json']).greeting).toBeUndefined();
    });

    it('cannot be edited or removed, being built in', async () => {
      await request(app)
        .patch(`/api/v1/namespaces/${namespace}/export_formats/flat_key_value`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Something else' })
        .expect(409);

      await request(app)
        .delete(`/api/v1/namespaces/${namespace}/export_formats/flat_key_value`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('cannot be redefined by a namespace', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'flat_key_value', name: 'Mine' })
        .expect(409);
    });
  });

  describe('formats a namespace creates', () => {
    it('creates one and uses it on a download', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          format_id: 'flat_text',
          name: 'Flat text',
          leaf_shape: 'STRING',
          nested: false,
        })
        .expect(201);

      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'flat_text' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const document = JSON.parse(response.text);
      // The dotted path stays one key rather than becoming a tree.
      expect(typeof document['greeting.hello']).toBe('string');
      expect(document.greeting).toBeUndefined();
    });

    it('renames the leaf fields of an object shape', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          format_id: 'renamed_fields',
          name: 'Renamed fields',
          value_field: 'text',
          hash_field: 'fingerprint',
        })
        .expect(201);

      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'renamed_fields' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Object.keys(JSON.parse(response.text).greeting.hello).sort()).toEqual([
        'fingerprint',
        'text',
      ]);
    });

    it('drops the fingerprint when the hash field is explicitly null', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'value_only', name: 'Value only', hash_field: null })
        .expect(201);

      const response = await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'value_only' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Object.keys(JSON.parse(response.text).greeting.hello)).toEqual(['value']);
    });

    it('lists a created format after the built in ones', async () => {
      const response = await request(app)
        .get(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const ids = response.body.data.export_formats.map((format) => format.format_id);
      expect(ids.slice(0, 3)).toEqual(['default', 'key_value', 'flat_key_value']);
      expect(ids).toContain('flat_text');
    });

    it('updates and then removes one', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'temporary', name: 'Temporary' })
        .expect(201);

      const updated = await request(app)
        .patch(`/api/v1/namespaces/${namespace}/export_formats/temporary`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed', nested: false })
        .expect(200);

      expect(updated.body.data.export_format.name).toBe('Renamed');
      expect(updated.body.data.export_format.nested).toBe(false);

      await request(app)
        .delete(`/api/v1/namespaces/${namespace}/export_formats/temporary`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'temporary' })
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('refusals', () => {
    it('refuses to redefine a built in identifier', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'default', name: 'Mine' })
        .expect(409);
    });

    it('refuses to edit or remove a built in format', async () => {
      await request(app)
        .patch(`/api/v1/namespaces/${namespace}/export_formats/key_value`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Something else' })
        .expect(409);

      await request(app)
        .delete(`/api/v1/namespaces/${namespace}/export_formats/key_value`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('refuses a duplicate identifier in the same namespace', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'flat_text', name: 'Again' })
        .expect(409);
    });

    it('refuses a field name that would reach the object prototype', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'polluted', name: 'Polluted', value_field: '__proto__' })
        .expect(422);
    });

    it('refuses naming leaf fields on a string shape, rather than ignoring them', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          format_id: 'confused',
          name: 'Confused',
          leaf_shape: 'STRING',
          value_field: 'value',
        })
        .expect(400);
    });

    it('refuses the same name for the value and the hash', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          format_id: 'collided',
          name: 'Collided',
          value_field: 'text',
          hash_field: 'text',
        })
        .expect(400);
    });

    it('refuses an undeclared field in the payload', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${token}`)
        .send({ format_id: 'sneaky', name: 'Sneaky', namespace_account_id: 'somebody_else' })
        .expect(422);
    });

    it('refuses an unknown format on a download', async () => {
      await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: 'not_a_format' })
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('refuses a malformed format identifier before it reaches the database', async () => {
      await request(app)
        .get(`/api/v1/files/${file.id}/download`)
        .query({ lang: 'th_th', export_format: '../../etc/passwd' })
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });
  });

  describe('namespace boundary', () => {
    let otherToken;
    let otherNamespace;

    beforeAll(async () => {
      const registered = await registerAccount(app, {
        user_id: 'format_outsider',
        email: 'format_outsider@example.test',
      });
      otherToken = registered.token;
      otherNamespace = registered.account.user_id;
    });

    it('hides a format created in another namespace', async () => {
      const response = await request(app)
        .get(`/api/v1/namespaces/${otherNamespace}/export_formats`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);

      expect(response.body.data.export_formats.map((format) => format.format_id)).toEqual([
        'default',
        'key_value',
        'flat_key_value',
      ]);
    });

    it('refuses to list another namespace with a 404', async () => {
      await request(app)
        .get(`/api/v1/namespaces/${namespace}/export_formats`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });

    it('refuses to remove a format belonging to another namespace', async () => {
      await request(app)
        .delete(`/api/v1/namespaces/${otherNamespace}/export_formats/flat_text`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });
  });

  describe('organization roles', () => {
    let orgToken;
    let memberToken;
    let orgId;

    beforeAll(async () => {
      const owner = await registerAccount(app, {
        user_id: 'format_owner',
        email: 'format_owner@example.test',
      });
      orgToken = owner.token;

      const member = await registerAccount(app, {
        user_id: 'format_member',
        email: 'format_member@example.test',
      });
      memberToken = member.token;

      const organization = await request(app)
        .post('/api/v1/namespaces/organizations')
        .set('Authorization', `Bearer ${orgToken}`)
        .send({ user_id: 'format_org', email: 'format_org@example.test' })
        .expect(201);
      orgId = organization.body.data.namespace.user_id;

      await request(app)
        .post(`/api/v1/namespaces/${orgId}/settings/members`)
        .set('Authorization', `Bearer ${orgToken}`)
        .send({ identifier: 'format_member', role: 'MEMBER' })
        .expect(201);
    });

    it('lets a plain member read the catalogue, since they pick one to download', async () => {
      await request(app)
        .get(`/api/v1/namespaces/${orgId}/export_formats`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200);
    });

    it('refuses a plain member creating one', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${orgId}/export_formats`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ format_id: 'member_made', name: 'Member made' })
        .expect(403);
    });

    it('lets an admin or owner create one', async () => {
      await request(app)
        .post(`/api/v1/namespaces/${orgId}/export_formats`)
        .set('Authorization', `Bearer ${orgToken}`)
        .send({ format_id: 'owner_made', name: 'Owner made' })
        .expect(201);
    });

    it('refuses a plain member removing one', async () => {
      await request(app)
        .delete(`/api/v1/namespaces/${orgId}/export_formats/owner_made`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(403);
    });
  });
});
