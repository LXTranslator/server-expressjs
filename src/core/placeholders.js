'use strict';

/**
 * Placeholder extraction for locale strings.
 *
 * A translated string has to carry the same interpolation tokens as the English
 * master it came from. `Hello {name}` translated as `สวัสดี {ชื่อ}` renders as
 * a literal brace at runtime, and `Hello %s` translated without the `%s`
 * crashes a printf style formatter outright. Neither failure is visible in the
 * editor, because both strings look perfectly reasonable on their own.
 *
 * This module finds those tokens so the two sides can be compared. It is
 * deliberately framework free and does no I/O: it takes text and returns
 * tokens.
 *
 * The families recognised cover what localization files actually contain:
 *
 * | Family | Example |
 * |---|---|
 * | Braces, single and double | `{name}`, `{{count}}`, `{count, plural, other {#}}` |
 * | Markup and component tags | `<b>`, `</b>`, `<br/>`, `<Link href="/a">`, `<0>` |
 * | printf | `%s`, `%d`, `%1$s`, `%.2f` |
 * | Named printf | `%(name)s` |
 * | Colon prefixed | `:id` |
 *
 * A token is compared as the exact text that was matched. That is stricter than
 * comparing names alone, and deliberately so: `<b>` and `<i>` are not
 * interchangeable, and neither are `%s` and `%d`.
 */

/**
 * One expression per family, tried in order at each position.
 *
 * Every part is bounded. An unbounded `[^{}]*` inside an alternation is how a
 * pattern like this turns into a way to spend the event loop on a hostile
 * string, and the strings here come from uploads.
 */
const PLACEHOLDER_PATTERN = new RegExp(
  [
    // {{count}} before {name}, so a double brace is one token rather than two.
    '\\{\\{[^{}]{0,200}\\}\\}',
    // One level of nesting, so an ICU message such as
    // "{count, plural, one {# item} other {# items}}" is a single token rather
    // than its inner arms. The two alternatives inside cannot both match the
    // same character, so this cannot backtrack quadratically.
    '\\{(?:[^{}]|\\{[^{}]{0,120}\\}){0,300}\\}',
    // Named printf before plain printf: "%(name)s" would otherwise be missed,
    // since "(" is not a conversion character.
    '%\\([A-Za-z0-9_]{1,60}\\)[a-zA-Z]',
    // A doubled percent is an escaped literal, not a conversion, and the space
    // flag is left out on purpose: supporting "% d" would make every "50% off"
    // in a locale file look like a placeholder.
    '%(?!%)(?:\\d{1,3}\\$)?[-+0#\']{0,4}\\d{0,4}(?:\\.\\d{1,4})?[a-zA-Z]',
    // Markup and component tags: <b>, </b>, <br/>, <Link href="/a">.
    '</?[A-Za-z][A-Za-z0-9]{0,40}(?:\\s[^<>]{0,200})?/?>',
    // Numbered component tags, as react-i18next writes them: <0>, </0>, <1/>.
    // Kept separate from the tag rule above so that "5<10 and 20>15" is prose
    // rather than a placeholder.
    '</?\\d{1,3}\\s*/?>',
    // :id, only where a word begins, so a URL or a clock time is not a token.
    '(?<![^\\s]):[A-Za-z_][A-Za-z0-9_]{0,60}',
  ].join('|'),
  'g',
);

/**
 * Extracts every placeholder token from a string, in the order they appear.
 *
 * @param {string} text Locale string.
 * @returns {string[]} Tokens, including repeats.
 */
function extractPlaceholders(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.match(PLACEHOLDER_PATTERN) ?? [];
}

/**
 * Counts each distinct token.
 *
 * @param {string[]} tokens Extracted tokens.
 * @returns {Map<string, number>} Token to occurrence count.
 */
function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compares the placeholders of a master string against a translation.
 *
 * Counts are compared rather than mere presence, because `{name} and {name}`
 * losing one of its two occurrences is just as broken as losing both.
 *
 * @param {string} masterText English master string.
 * @param {string} translatedText Translated string.
 * @returns {{missing: Array<object>, unexpected: Array<object>, master: string[], translation: string[]}}
 *   Tokens the translation lacks, tokens it invented, and both token lists.
 */
function comparePlaceholders(masterText, translatedText) {
  const master = extractPlaceholders(masterText);
  const translation = extractPlaceholders(translatedText);

  const masterCounts = countTokens(master);
  const translationCounts = countTokens(translation);

  const missing = [];
  const unexpected = [];

  for (const [token, expected] of masterCounts) {
    const found = translationCounts.get(token) ?? 0;
    if (found < expected) missing.push({ token, expected, found });
  }

  for (const [token, found] of translationCounts) {
    const expected = masterCounts.get(token) ?? 0;
    if (found > expected) unexpected.push({ token, expected, found });
  }

  return { missing, unexpected, master, translation };
}

module.exports = { extractPlaceholders, comparePlaceholders, PLACEHOLDER_PATTERN };
