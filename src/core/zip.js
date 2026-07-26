'use strict';

const zlib = require('node:zlib');

/**
 * Minimal ZIP archive writer.
 *
 * Exists so the whole locale set can be downloaded as one file. It is hand
 * rolled rather than pulled from npm because the archive this application needs
 * is the simple case of the format: a handful of small text entries, written in
 * one pass, held in memory. Node already supplies the only hard part, DEFLATE,
 * through `zlib`. See `.agents/security/supply-chain.md` on preferring a
 * standard library equivalent.
 *
 * What it deliberately does not implement: ZIP64, encryption, split archives,
 * directory entries and data descriptors. Every one of those limits is checked
 * and throws rather than emitting an archive that some readers accept and
 * others reject.
 */

/** Local file header. */
const SIGNATURE_LOCAL = 0x04034b50;
/** Central directory file header. */
const SIGNATURE_CENTRAL = 0x02014b50;
/** End of central directory record. */
const SIGNATURE_END = 0x06054b50;

/** Deflate, the only method emitted here. */
const METHOD_DEFLATE = 8;

/** Bit 11 declares the filename to be UTF-8 rather than the legacy code page. */
const FLAG_UTF8 = 0x0800;

/** Version 2.0 is what DEFLATE requires a reader to support. */
const VERSION = 20;

/** Fields beyond these need ZIP64, which this writer does not emit. */
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

/** CRC-32 lookup table, built once on load. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/**
 * Computes the CRC-32 of a buffer.
 *
 * Implemented here rather than taken from `zlib.crc32`, which only exists from
 * Node 20.15, while this project supports Node 20 generally.
 *
 * @param {Buffer} buffer Bytes to checksum.
 * @returns {number} Unsigned 32 bit checksum.
 */
function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Encodes a timestamp in the MS-DOS form the format requires.
 *
 * Seconds have two second resolution and the year is relative to 1980, which is
 * the format's limitation rather than a choice. Dates before 1980 are clamped,
 * since a negative year field would produce an archive readers reject.
 *
 * @param {Date} date Timestamp to encode.
 * @returns {{time: number, date: number}} Packed DOS time and date.
 */
function toDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds one entry's local header, compressed payload and central record.
 *
 * @param {object} params Entry parameters.
 * @param {string} params.name Path inside the archive.
 * @param {Buffer} params.content Uncompressed bytes.
 * @param {Date} params.modified Timestamp to record.
 * @param {number} params.offset Byte offset of this entry's local header.
 * @returns {{local: Buffer, central: Buffer, size: number}} Encoded parts.
 * @throws {Error} When the entry exceeds what this writer can encode.
 */
function buildEntry({ name, content, modified, offset }) {
  const nameBytes = Buffer.from(name, 'utf8');
  const compressed = zlib.deflateRawSync(content);
  const { time, date } = toDosDateTime(modified);
  const checksum = crc32(content);

  if (content.length > MAX_UINT32 || compressed.length > MAX_UINT32) {
    throw new Error(`The archive entry "${name}" is too large for a non ZIP64 archive.`);
  }
  if (nameBytes.length > MAX_UINT16) {
    throw new Error(`The archive entry name "${name}" is too long.`);
  }

  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(SIGNATURE_LOCAL, 0);
  local.writeUInt16LE(VERSION, 4);
  local.writeUInt16LE(FLAG_UTF8, 6);
  local.writeUInt16LE(METHOD_DEFLATE, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(SIGNATURE_CENTRAL, 0);
  central.writeUInt16LE(VERSION, 4);
  central.writeUInt16LE(VERSION, 6);
  central.writeUInt16LE(FLAG_UTF8, 8);
  central.writeUInt16LE(METHOD_DEFLATE, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  // External attributes: regular file, mode 0644, in the high two bytes as
  // Unix writers record it.
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  nameBytes.copy(central, 46);

  return { local, central, compressed, size: local.length + compressed.length };
}

/**
 * Rejects an entry name that would escape the archive when extracted.
 *
 * A ZIP entry name is a path, and an extractor that trusts it will happily
 * write outside the destination directory. Names here are generated from locale
 * codes the server has already validated, so this is a second line rather than
 * the only one.
 *
 * @param {string} name Candidate entry name.
 * @returns {string} The accepted name.
 * @throws {Error} When the name is absolute, traverses upward or is empty.
 */
function assertSafeEntryName(name) {
  const value = String(name);

  if (value.length === 0) {
    throw new Error('An archive entry name must not be empty.');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`The archive entry name "${name}" must be relative.`);
  }
  if (value.includes('\\')) {
    throw new Error(`The archive entry name "${name}" must not contain a backslash.`);
  }
  if (value.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`The archive entry name "${name}" must not traverse directories.`);
  }
  // A null byte truncates the name for a reader written in C, so the name a
  // person sees and the name that is written can differ.
  if (value.includes('\0')) {
    throw new Error('An archive entry name must not contain a null byte.');
  }

  return value;
}

/**
 * Builds a ZIP archive in memory.
 *
 * @param {Array<{name: string, content: string|Buffer}>} entries Files to store.
 * @param {object} [options] Archive options.
 * @param {Date} [options.modified] Timestamp recorded on every entry.
 * @returns {Buffer} The complete archive.
 * @throws {Error} When an entry name is unsafe or the archive exceeds the format.
 */
function createZipArchive(entries, { modified = new Date() } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('An archive needs at least one entry.');
  }
  if (entries.length > MAX_UINT16) {
    throw new Error('Too many entries for a non ZIP64 archive.');
  }

  const seen = new Set();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = assertSafeEntryName(entry.name);

    // Duplicate names are legal in the format and a trap in practice: which one
    // survives extraction is up to the reader.
    if (seen.has(name)) {
      throw new Error(`The archive entry "${name}" is listed more than once.`);
    }
    seen.add(name);

    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content), 'utf8');

    const built = buildEntry({ name, content, modified, offset });
    parts.push(built.local, built.compressed);
    central.push(built.central);
    offset += built.size;
  }

  const centralBytes = Buffer.concat(central);

  if (offset > MAX_UINT32 || centralBytes.length > MAX_UINT32) {
    throw new Error('The archive is too large for a non ZIP64 archive.');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIGNATURE_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBytes, end]);
}

module.exports = { createZipArchive, crc32, assertSafeEntryName };
