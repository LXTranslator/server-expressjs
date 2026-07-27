'use strict';

const { z } = require('zod');
const { isReservedIdentifier } = require('../../core/reservedIdentifiers');

/**
 * Request schemas for the authentication module.
 *
 * These mirror the client side rules exactly. The client validates for a fast,
 * helpful form experience; the server validates because client checks are only
 * a convenience and can be bypassed entirely.
 *
 * `.strict()` on every object is what blocks mass assignment: a payload
 * carrying an undeclared field such as `type` or `role` is rejected outright
 * rather than quietly ignored.
 */

/**
 * Routing identifier: lowercase letters, digits and underscores.
 *
 * The identifier is also the first segment of the namespace's client URL, so a
 * handful of names the client already routes are refused. See
 * `core/reservedIdentifiers`.
 */
const userIdFormatSchema = z
  .string()
  .trim()
  .min(3, 'The user id must be at least 3 characters.')
  .max(32, 'The user id must be 32 characters or fewer.')
  .regex(
    /^[a-z0-9_]+$/,
    'The user id may contain only lowercase letters, digits and underscores.',
  );

const userIdSchema = userIdFormatSchema.refine((value) => !isReservedIdentifier(value), {
  message: 'That user id is reserved. Choose another.',
});

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'The email address is too long.')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address.');

/**
 * Password policy.
 *
 * Length carries most of the strength, so the floor is deliberately higher than
 * the usual eight characters, with a light character mix requirement on top.
 */
const passwordSchema = z
  .string()
  .min(10, 'The password must be at least 10 characters.')
  .max(200, 'The password must be 200 characters or fewer.')
  .regex(/[a-z]/, 'The password must contain a lowercase letter.')
  .regex(/[A-Z]/, 'The password must contain an uppercase letter.')
  .regex(/[0-9]/, 'The password must contain a digit.');

const registerSchema = z
  .object({
    user_id: userIdSchema,
    email: emailSchema,
    password: passwordSchema,
    confirm_password: z.string(),
  })
  .strict()
  .refine((data) => data.password === data.confirm_password, {
    message: 'The passwords do not match.',
    path: ['confirm_password'],
  });

const loginSchema = z
  .object({
    // Accepts either form, because the login page offers a single field.
    identifier: z.string().trim().min(1, 'Enter your user id or email address.').max(254),
    password: z.string().min(1, 'Enter your password.').max(200),
  })
  .strict();

const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'The reset token is missing.').max(4096),
    password: passwordSchema,
    confirm_password: z.string(),
  })
  .strict()
  .refine((data) => data.password === data.confirm_password, {
    message: 'The passwords do not match.',
    path: ['confirm_password'],
  });

/*
 * The probe validates the shape only. A reserved identifier is well formed and
 * simply unavailable, so it is answered as taken rather than rejected, which is
 * what keeps the inline hint on the registration form consistent with what
 * submitting it would do.
 */
const availabilitySchema = z
  .object({
    user_id: userIdFormatSchema.optional(),
    email: emailSchema.optional(),
  })
  .strict()
  .refine((data) => data.user_id !== undefined || data.email !== undefined, {
    message: 'Provide a user id or an email address to check.',
  });

/**
 * Creating a machine credential.
 *
 * The name is required rather than optional, because a list of unnamed machine
 * credentials is a list nobody can safely prune: the whole point of the screen
 * is deciding which of them you still recognise.
 */
const createApiTokenSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the token, so you can recognise it later.').max(100),
    /** Absent means no expiry, which is the ordinary case for a build script. */
    expires_in_days: z.number().int().min(1).max(365).optional(),
  })
  .strict();

module.exports = {
  createApiTokenSchema,
  userIdSchema,
  userIdFormatSchema,
  emailSchema,
  passwordSchema,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  availabilitySchema,
};
