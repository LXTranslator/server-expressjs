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
const { createZipArchive, crc32, assertSafeEntryName } = require('../src/core/zip');

/*
 * The archive download.
 *
 * The ZIP writer is hand rolled, so these tests read the bytes back rather than
 * trusting the writer to describe itself: the central directory is parsed, each
 * entry is inflated, and every CRC is recomputed. That is what an extractor
 * does, and it is the only way a format defect surfaces here rather than in
 * somebody's download.
 */

/** End of central directory signature. */
const SIGNATURE_END = 0x06054b50;

/**
 * Reads a ZIP archive the way an extractor does.
 *
 * @param {Buffer} archive Complete archive bytes.
 * @returns {Array<{name: string, content: string}>} Entries in directory order.
 * @throws {Error} When the archive is malformed.
 */
function readZipArchive(archive) {
  // The end record is last, and has no fixed offset because it may carry a
  // comment, so it is found by scanning backwards for its signature.
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
  const entries = [];

  for (let index = 0; index < total; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Bad central directory signature.');
    }

    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Bad local header for ${name}.`);
    }

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(stored) : stored;

    if (content.length !== uncompressedSize) {
      throw new Error(`Size mismatch for ${name}.`);
    }
    if (crc32(content) !== expectedCrc) {
      throw new Error(`Checksum mismatch for ${name}.`);
    }

    entries.push({ name, content: content.toString('utf8') });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe('zip writer', () => {
  it('round trips entries through a reader that verifies every checksum', () => {
    const archive = createZipArchive([
      { name: 'en_us.json', content: '{"a":1}' },
      { name: 'th_th.json', content: '{"a":2}' },
    ]);

    expect(readZipArchive(archive)).toEqual([
      { name: 'en_us.json', content: '{"a":1}' },
      { name: 'th_th.json', content: '{"a":2}' },
    ]);
  });

  it('begins with the local header signature, which is how a reader sniffs it', () => {
    const archive = createZipArchive([{ name: 'a.json', content: '{}' }]);
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('carries multibyte text through unchanged', () => {
    // The locale documents are mostly non Latin text, so this is the normal
    // case rather than an edge one.
    const thai = '{"hello":"สวัสดีชาวโลก"}';
    const japanese = '{"hello":"こんにちは世界"}';

    const entries = readZipArchive(
      createZipArchive([
        { name: 'th_th.json', content: thai },
        { name: 'ja_jp.json', content: japanese },
      ]),
    );

    expect(entries[0].content).toBe(thai);
    expect(entries[1].content).toBe(japanese);
  });

  it('marks names as UTF-8 so a reader does not decode them as a code page', () => {
    const archive = createZipArchive([{ name: 'en_us.json', content: '{}' }]);
    // General purpose flag, bit 11.
    expect(archive.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it('actually compresses repetitive content', () => {
    const content = JSON.stringify({ key: 'value '.repeat(500) });
    const archive = createZipArchive([{ name: 'big.json', content }]);

    expect(archive.length).toBeLessThan(content.length / 2);
    expect(readZipArchive(archive)[0].content).toBe(content);
  });

  it('computes a known CRC-32', () => {
    // The check value from the zlib specification, so a rewritten table is
    // caught rather than being consistently wrong.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  describe('entry names', () => {
    it.each([
      ['an absolute path', '/etc/passwd'],
      ['a parent traversal', '../../etc/passwd'],
      ['a traversal in the middle', 'a/../../b.json'],
      ['a windows drive', 'C:/windows/system32'],
      ['a backslash', 'a\\b.json'],
      ['a single dot segment', './a.json'],
      ['an empty name', ''],
    ])('refuses %s', (_label, name) => {
      // An extractor that trusts the name writes outside its destination, so
      // the archive must never carry one of these in the first place.
      expect(() => assertSafeEntryName(name)).toThrow();
    });

    it('refuses a name carrying a null byte', () => {
      expect(() => assertSafeEntryName('a\u0000.json')).toThrow(/null byte/);
    });

    it('accepts an ordinary locale filename', () => {
      expect(assertSafeEntryName('en_us.json')).toBe('en_us.json');
    });

    it('refuses a duplicate entry, which extracts unpredictably', () => {
      expect(() =>
        createZipArchive([
          { name: 'en_us.json', content: '{}' },
          { name: 'en_us.json', content: '{}' },
        ]),
      ).toThrow(/more than once/);
    });

    it('refuses an empty archive', () => {
      expect(() => createZipArchive([])).toThrow(/at least one entry/);
    });
  });
});

describe('archive download', () => {
  let app;
  let token;
  let file;

  beforeAll(async () => {
    app = await setupTestApp();
    const registered = await registerAccount(app, {
      user_id: 'archive_user',
      email: 'archive@example.test',
    });
    token = registered.token;
    const project = await createProject(app, token, registered.account.user_id);

    const response = await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('source_lang', 'en_us')
      .field('target_langs', 'th_th,ja_jp')
      .attach(
        'file',
        Buffer.from(JSON.stringify({ greeting: { hello: 'Hello' }, save: 'Save' })),
        'archive_case.json',
      )
      .expect(202);

    file = await waitForFile(app, token, response.body.data.file.id);
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  it('returns every locale in one archive named langs.zip', async () => {
    const response = await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .query({ format: 'zip' })
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe('attachment; filename="langs.zip"');
    expect(Number(response.headers['content-length'])).toBe(response.body.length);

    const entries = readZipArchive(response.body);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'en_us.json',
      'ja_jp.json',
      'th_th.json',
    ]);

    // Each entry is the same document the single locale download returns, so
    // unpacking the archive and downloading one by one agree.
    const master = JSON.parse(entries.find((entry) => entry.name === 'en_us.json').content);
    expect(master.greeting.hello.value).toBe('Hello');
    expect(master.greeting.hello.hash).toEqual(expect.any(String));
  });

  it('leaves the existing download shapes alone', async () => {
    const envelope = await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Object.keys(envelope.body.data.files).sort()).toEqual([
      'en_us.json',
      'ja_jp.json',
      'th_th.json',
    ]);

    const single = await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .query({ lang: 'th_th' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(single.headers['content-disposition']).toBe('attachment; filename="th_th.json"');
  });

  it('rejects an unknown format rather than guessing', async () => {
    await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .query({ format: 'tar' })
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });

  it('refuses the archive to another account', async () => {
    const outsider = await registerAccount(app, {
      user_id: 'archive_outsider',
      email: 'archive_outsider@example.test',
    });

    await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .query({ format: 'zip' })
      .set('Authorization', `Bearer ${outsider.token}`)
      .expect(404);
  });
});
