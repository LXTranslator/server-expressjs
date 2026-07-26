'use strict';

const { z } = require('zod');
const { userIdSchema, emailSchema, passwordSchema } = require('../auth/auth.schemas');

/** Token minted by the confirm step and spent on exactly one change. */
const settingsTokenSchema = z.string().min(1, 'Confirm your password first.').max(4096);

const confirmPasswordSchema = z
  .object({ password: z.string().min(1, 'Enter your current password.').max(200) })
  .strict();

const updateUserIdSchema = z.object({ token: settingsTokenSchema, user_id: userIdSchema }).strict();

const updateEmailSchema = z.object({ token: settingsTokenSchema, email: emailSchema }).strict();

const updatePasswordSchema = z
  .object({
    token: settingsTokenSchema,
    password: passwordSchema,
    confirm_password: z.string(),
  })
  .strict()
  .refine((data) => data.password === data.confirm_password, {
    message: 'The passwords do not match.',
    path: ['confirm_password'],
  });

const updateProfileSchema = z
  .object({
    display_name: z.string().trim().max(120).optional(),
    description: z.string().trim().max(500).optional(),
    website_url: z.string().trim().url('Enter a valid URL.').max(255).optional(),
  })
  .strict();

module.exports = {
  confirmPasswordSchema,
  updateUserIdSchema,
  updateEmailSchema,
  updatePasswordSchema,
  updateProfileSchema,
};
