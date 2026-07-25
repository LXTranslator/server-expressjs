'use strict';

const { z } = require('zod');
const { userIdSchema, emailSchema } = require('../auth/auth.schemas');
const { MEMBER_ROLES } = require('../../infrastructure/database/models/orgMember');

const createOrganizationSchema = z
  .object({
    user_id: userIdSchema,
    email: emailSchema,
    display_name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

const updateOrganizationSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    website_url: z.string().trim().url('Enter a valid URL.').max(255).optional(),
  })
  .strict();

const addMemberSchema = z
  .object({
    identifier: z
      .string()
      .trim()
      .min(1, 'Enter the user id or email address of the person to invite.')
      .max(254),
    // The role is an explicit allowlist, so an arbitrary string can never reach
    // the database and become an unrecognised privilege level.
    role: z.enum(MEMBER_ROLES).optional(),
  })
  .strict();

const updateMemberSchema = z.object({ role: z.enum(MEMBER_ROLES) }).strict();

module.exports = {
  createOrganizationSchema,
  updateOrganizationSchema,
  addMemberSchema,
  updateMemberSchema,
};
