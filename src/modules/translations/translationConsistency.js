'use strict';

const { comparePlaceholders } = require('../../core/placeholders');
const { MASTER_LANG_CODE } = require('../../infrastructure/database/models/file');

/**
 * Key consistency between the English master and every other language.
 *
 * The pipeline guarantees that a translation was produced from the master. It
 * cannot guarantee that the translation still says the same thing structurally
 * afterwards: a model may drop a placeholder, a reviewer may retype `{name}` in
 * their own language, and a locale added later may simply not cover every key.
 *
 * None of that is visible in the editor, because each string looks fine on its
 * own. It becomes visible when the application renders a literal brace, or a
 * formatter is handed fewer arguments than its format string expects.
 *
 * This check is on demand rather than on write. It reads every key and every
 * translation of a file, which is exactly the work that should not happen on
 * each keystroke of an edit. A reviewer runs it when they want the answer.
 */

/** What can be wrong with one key in one language. */
const CONSISTENCY_ISSUE_KINDS = Object.freeze({
  /** The language has no row for this key at all. */
  MISSING_TRANSLATION: 'MISSING_TRANSLATION',
  /** A row exists but holds no text, while the master does. */
  EMPTY_TRANSLATION: 'EMPTY_TRANSLATION',
  /** The master changed after this translation was written. */
  STALE_TRANSLATION: 'STALE_TRANSLATION',
  /** A token the master carries is absent, or appears fewer times. */
  PLACEHOLDER_MISSING: 'PLACEHOLDER_MISSING',
  /** A token the master does not carry, or appears more times. */
  PLACEHOLDER_UNEXPECTED: 'PLACEHOLDER_UNEXPECTED',
});

/**
 * Ceiling on the issues one report carries.
 *
 * A file at the key limit with fifty locales could otherwise produce a response
 * far larger than anything else the API returns. The count is always exact; it
 * is the list that stops.
 */
const MAX_REPORTED_ISSUES = 500;

/**
 * Builds the consistency report for a file's loaded keys.
 *
 * @param {object} params Report parameters.
 * @param {Array<object>} params.translationKeys Keys with their translations loaded.
 * @param {string[]} params.langCodes Locales to check, master excluded.
 * @param {number} [params.limit] Maximum issues to list.
 * @returns {object} Report body, ready to serialise.
 */
function buildConsistencyReport({ translationKeys, langCodes, limit = MAX_REPORTED_ISSUES }) {
  const locales = langCodes.filter((code) => code !== MASTER_LANG_CODE);
  const issues = [];
  let issueCount = 0;

  /**
   * Records one issue, keeping the count exact once the list is full.
   *
   * @param {object} issue Issue body.
   * @returns {void}
   */
  function report(issue) {
    issueCount += 1;
    if (issues.length < limit) issues.push(issue);
  }

  for (const key of translationKeys) {
    const byLang = new Map(
      (key.translations ?? []).map((translation) => [translation.langCode, translation]),
    );

    for (const langCode of locales) {
      const base = { key_id: key.id, key_name: key.keyName, lang_code: langCode };
      const translation = byLang.get(langCode);

      if (translation === undefined) {
        report({
          ...base,
          kind: CONSISTENCY_ISSUE_KINDS.MISSING_TRANSLATION,
          detail: 'This language has no translation for the key.',
        });
        continue;
      }

      if (key.originalText.trim().length > 0 && translation.translatedText.trim().length === 0) {
        report({
          ...base,
          kind: CONSISTENCY_ISSUE_KINDS.EMPTY_TRANSLATION,
          detail: 'The translation is empty while the master text is not.',
        });
      }

      if (translation.sourceHash !== null && translation.sourceHash !== key.textHash) {
        report({
          ...base,
          kind: CONSISTENCY_ISSUE_KINDS.STALE_TRANSLATION,
          detail: 'The master text changed after this translation was written.',
          translated_with_hash: translation.sourceHash,
          current_hash: key.textHash,
        });
      }

      const { missing, unexpected } = comparePlaceholders(
        key.originalText,
        translation.translatedText,
      );

      for (const entry of missing) {
        report({
          ...base,
          kind: CONSISTENCY_ISSUE_KINDS.PLACEHOLDER_MISSING,
          detail:
            entry.found === 0
              ? `The master carries ${entry.token} and the translation does not.`
              : `The master carries ${entry.token} ${entry.expected} times and the translation ${entry.found}.`,
          token: entry.token,
          expected_count: entry.expected,
          found_count: entry.found,
        });
      }

      for (const entry of unexpected) {
        report({
          ...base,
          kind: CONSISTENCY_ISSUE_KINDS.PLACEHOLDER_UNEXPECTED,
          detail:
            entry.expected === 0
              ? `The translation carries ${entry.token} and the master does not.`
              : `The translation carries ${entry.token} ${entry.found} times and the master ${entry.expected}.`,
          token: entry.token,
          expected_count: entry.expected,
          found_count: entry.found,
        });
      }
    }
  }

  return {
    master_lang_code: MASTER_LANG_CODE,
    checked_lang_codes: locales,
    checked_key_count: translationKeys.length,
    consistent: issueCount === 0,
    issue_count: issueCount,
    truncated: issueCount > issues.length,
    issues,
  };
}

module.exports = {
  buildConsistencyReport,
  CONSISTENCY_ISSUE_KINDS,
  MAX_REPORTED_ISSUES,
};
