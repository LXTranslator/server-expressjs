'use strict';

const { z } = require('zod');

/**
 * Request schemas for the second factor.
 *
 * `.strict()` on every object, so a payload carrying an undeclared field is
 * rejected rather than quietly ignored.
 */

/**
 * A submitted code, which may be either kind.
 *
 * The bounds are deliberately loose because two shapes share this field: six
 * digits from an authenticator, or a longer grouped recovery code. Telling the
 * two apart is the service's job, not the schema's, so that a person who
 * reaches for a recovery code does not first have to say which kind it is.
 */
const codeSchema = z
  .string()
  .trim()
  .min(6, 'Enter the code from your authenticator app.')
  .max(64, 'That code is too long.');

const confirmSchema = z.object({ code: codeSchema }).strict();

const disableSchema = z.object({ settings_token: z.string().min(1) }).strict();

const setupSchema = z.object({ settings_token: z.string().min(1) }).strict();

const regenerateSchema = z.object({ settings_token: z.string().min(1) }).strict();

const enableSchema = z
  .object({ settings_token: z.string().min(1), code: codeSchema })
  .strict();

const challengeSchema = z
  .object({
    challenge_token: z.string().min(1, 'That sign in attempt is invalid or has expired.'),
    code: codeSchema,
  })
  .strict();

module.exports = {
  codeSchema,
  setupSchema,
  confirmSchema,
  enableSchema,
  disableSchema,
  regenerateSchema,
  challengeSchema,
};
