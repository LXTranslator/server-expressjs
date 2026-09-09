'use strict';

const { z } = require('zod');

/**
 * Request schemas for provider sign in.
 *
 * `.strict()` throughout, so a payload carrying an undeclared field is rejected
 * rather than quietly ignored. Note what is *not* declared here: no redirect
 * URI and no provider on the callback. The redirect is a server side constant,
 * and the provider is read from the state row, because a caller who could name
 * either could aim the flow somewhere of their choosing.
 */

const stateSchema = z
  .string()
  .trim()
  .min(16, 'That sign in attempt is invalid or has expired.')
  .max(128, 'That sign in attempt is invalid or has expired.');

const codeSchema = z
  .string()
  .trim()
  .min(1, 'That sign in attempt is invalid or has expired.')
  .max(2048, 'That sign in attempt is invalid or has expired.');

const startSchema = z.object({}).strict();

const callbackSchema = z.object({ state: stateSchema, code: codeSchema }).strict();

module.exports = { startSchema, callbackSchema };
