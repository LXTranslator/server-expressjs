'use strict';

const { z } = require('zod');
const {
  LEAF_SHAPES,
  FORMAT_ID_PATTERN,
  FIELD_NAME_PATTERN,
} = require('../../infrastructure/database/models/exportFormat');

/**
 * The identifier a client sends to select a format.
 *
 * It reaches a query string and a stored unique key, so the character set is
 * the same narrow one used for namespace identifiers.
 */
const formatIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    FORMAT_ID_PATTERN,
    'Use 2 to 50 lowercase letters, digits and underscores for the format identifier.',
  );

/** A leaf field name is written as a JSON key, so it is checked before storage. */
const fieldNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    FIELD_NAME_PATTERN,
    'A field name starts with a letter and holds lowercase letters, digits and underscores.',
  );

const createExportFormatSchema = z
  .object({
    format_id: formatIdSchema,
    name: z.string().trim().min(1, 'Name the format.').max(80),
    description: z.string().trim().max(500).optional(),
    leaf_shape: z.enum(LEAF_SHAPES).optional(),
    value_field: fieldNameSchema.optional(),
    /** Null is meaningful here: it asks for a leaf with no fingerprint. */
    hash_field: fieldNameSchema.nullable().optional(),
    nested: z.boolean().optional(),
  })
  .strict();

/**
 * The identifier is absent on purpose: a build script downloads with
 * `export_format=`, so renaming one would break it silently.
 */
const updateExportFormatSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    leaf_shape: z.enum(LEAF_SHAPES).optional(),
    value_field: fieldNameSchema.optional(),
    hash_field: fieldNameSchema.nullable().optional(),
    nested: z.boolean().optional(),
  })
  .strict();

module.exports = { createExportFormatSchema, updateExportFormatSchema, formatIdSchema };
