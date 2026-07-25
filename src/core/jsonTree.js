'use strict';

const { BadRequestError } = require('./errors');

/**
 * Keys that must never be written into a plain object, because assigning them
 * mutates `Object.prototype` and poisons every object in the process.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Separator used to express nesting in a flattened key path. */
const PATH_SEPARATOR = '.';

/**
 * Rejects key segments that could be used for prototype pollution.
 *
 * @param {string} segment One path segment.
 * @throws {BadRequestError} When the segment is unsafe.
 */
function assertSafeSegment(segment) {
  if (FORBIDDEN_KEYS.has(segment)) {
    throw new BadRequestError(`The key segment "${segment}" is not allowed.`);
  }
}

/**
 * Flattens a nested translation object into `{ "a.b.c": "text" }` pairs.
 *
 * Only strings are treated as translatable leaves. Numbers and booleans are
 * stringified, and null is skipped, which matches how locale files are written
 * in practice.
 *
 * @param {object} source Parsed JSON object.
 * @param {{maxDepth: number, maxKeys: number}} limits Guard rails against hostile input.
 * @returns {Array<{keyName: string, originalText: string}>} Ordered leaves.
 * @throws {BadRequestError} When the payload breaches a limit or is unsafe.
 */
function flattenTranslationTree(source, limits) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new BadRequestError('The translation file must contain a JSON object at its root.');
  }

  const leaves = [];

  /**
   * @param {object} node Current subtree.
   * @param {string[]} trail Accumulated path segments.
   * @param {number} depth Current depth.
   */
  function walk(node, trail, depth) {
    if (depth > limits.maxDepth) {
      throw new BadRequestError(`The translation file nests deeper than ${limits.maxDepth} levels.`);
    }

    for (const [key, value] of Object.entries(node)) {
      assertSafeSegment(key);

      if (key.length === 0) {
        throw new BadRequestError('The translation file contains an empty key name.');
      }

      const trailNext = [...trail, key];

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, trailNext, depth + 1);
        continue;
      }

      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        throw new BadRequestError(
          `The key "${trailNext.join(PATH_SEPARATOR)}" holds an array, which is not translatable.`,
        );
      }

      if (leaves.length >= limits.maxKeys) {
        throw new BadRequestError(
          `The translation file holds more than ${limits.maxKeys} translatable keys.`,
        );
      }

      leaves.push({ keyName: trailNext.join(PATH_SEPARATOR), originalText: String(value) });
    }
  }

  walk(source, [], 1);

  if (leaves.length === 0) {
    throw new BadRequestError('The translation file contains no translatable text.');
  }

  return leaves;
}

/**
 * Rebuilds a nested object from flattened `a.b.c` paths.
 *
 * Uses a null prototype internally so a malicious path can never reach
 * `Object.prototype`, then hands back a plain object for serialisation.
 *
 * @param {Array<{keyName: string, value: *}>} entries Flattened entries.
 * @returns {object} Nested object.
 */
function expandTranslationTree(entries) {
  const root = Object.create(null);

  for (const { keyName, value } of entries) {
    const segments = String(keyName).split(PATH_SEPARATOR);
    let cursor = root;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      assertSafeSegment(segment);

      if (index === segments.length - 1) {
        cursor[segment] = value;
        break;
      }

      if (
        cursor[segment] === undefined ||
        cursor[segment] === null ||
        typeof cursor[segment] !== 'object'
      ) {
        cursor[segment] = Object.create(null);
      }
      cursor = cursor[segment];
    }
  }

  // Round tripping through JSON drops the null prototypes without losing data.
  return JSON.parse(JSON.stringify(root));
}

module.exports = { flattenTranslationTree, expandTranslationTree, PATH_SEPARATOR, FORBIDDEN_KEYS };
