'use strict';

const { z } = require('zod');
const exportFormatService = require('../../exportFormats/exportFormat.service');
const exportFormatSchemas = require('../../exportFormats/exportFormat.schemas');
const { LEAF_SHAPES } = require('../../../infrastructure/database/models/exportFormat');
const { defineArguments, NO_ARGUMENTS, ok, attempt, requireAdmin } = require('./shared');

/** Tools about the shapes a locale file can be downloaded in. */

/**
 * A sample of what a format produces.
 *
 * Rendered by the real export builder, so what the person is shown cannot drift
 * from what a download produces.
 *
 * @param {object} format Client safe export format.
 * @returns {object} The sample document.
 */
function previewOf(format) {
  return exportFormatService.previewFormat({
    leafShape: format.leaf_shape,
    valueField: format.value_field,
    hashField: format.hash_field,
    nested: format.nested,
  });
}

const listExportFormats = {
  name: 'list_export_formats',
  description:
    'List the shapes a locale file can be downloaded in for the current namespace, including the three built in ones, each with a sample of what it produces. Call this before creating a format: a flat dotted key map and a nested one both ship already.',
  ...NO_ARGUMENTS,

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    const formats = await exportFormatService.listFormats(context.namespace.id);

    return ok({
      export_formats: formats.map((format) => ({ ...format, preview: previewOf(format) })),
      message: `The ${context.namespace.userId} namespace offers ${formats.length} export formats.`,
      instruction:
        'Show the person the preview of a format rather than describing its fields. If one already produces the shape they asked for, say so instead of creating a duplicate.',
    });
  },
};

const createExportFormat = {
  name: 'create_export_format',
  description: [
    'Create a new shape for downloaded locale files in the current namespace.',
    'A format is described by four choices, never by a template string:',
    'leaf_shape STRING with nested false gives {"greeting.hello": "สวัสดี"};',
    'leaf_shape STRING with nested true gives {"greeting": {"hello": "สวัสดี"}};',
    'leaf_shape OBJECT gives a leaf carrying named fields, for example',
    '{"greeting": {"hello": {"value": "สวัสดี", "hash": "..."}}}.',
    'Translate what the person asks for into these choices, then show them the preview.',
  ].join(' '),
  ...defineArguments({
    format_id: [
      exportFormatSchemas.formatIdSchema,
      {
        type: 'string',
        description:
          'Identifier a download names this format by, 2 to 50 lowercase letters, digits and underscores. Cannot be "default", "key_value" or "flat_key_value", which are built in.',
      },
    ],
    name: [
      z.string().trim().min(1).max(80),
      { type: 'string', description: 'Human readable name shown in a dropdown.' },
    ],
    description: [
      z.string().trim().max(500).optional(),
      { type: 'string', description: 'What this shape is for, for the person choosing it later.' },
    ],
    leaf_shape: [
      z.enum(LEAF_SHAPES).optional(),
      {
        type: 'string',
        enum: ['STRING', 'OBJECT'],
        description:
          'STRING writes the translation directly. OBJECT writes an object carrying value_field and hash_field. Defaults to OBJECT.',
      },
    ],
    value_field: [
      z.string().trim().max(40).optional(),
      {
        type: 'string',
        description: 'Field holding the translation. OBJECT only. Defaults to "value".',
      },
    ],
    hash_field: [
      z.string().trim().max(40).nullable().optional(),
      {
        type: 'string',
        description:
          'Field holding the fingerprint of the English master. OBJECT only. Defaults to "hash". Pass null for a leaf with no fingerprint.',
      },
    ],
    nested: [
      z.boolean().optional(),
      {
        type: 'boolean',
        description:
          'True expands greeting.hello into nested objects. False keeps the dotted path as one key. Defaults to true.',
      },
    ],
  }),

  /**
   * @param {object} args Validated arguments.
   * @param {object} context Tool context.
   * @returns {Promise<object>} Tool result.
   */
  async handler(args, context) {
    // A format belongs to the namespace and every project underneath it, so
    // writing one is an ADMIN action exactly as the endpoint makes it.
    const denied = requireAdmin(context.namespace, context.namespaceRole);
    if (denied !== null) return denied;

    const { value: format, failure } = await attempt(
      () => exportFormatService.createFormat(context.namespace.id, args),
      {
        instruction:
          'Explain what was refused and offer a different identifier, or an existing format that already produces that shape.',
      },
    );
    if (failure !== null) return failure;

    return ok({
      export_format: format,
      preview: previewOf(format),
      message: `Created the export format "${format.name}".`,
      instruction:
        'Show the person the preview so they can confirm it is the shape they meant, and tell them it is now selectable on the download screen of every project in this namespace.',
    });
  },
};

module.exports = { listExportFormats, createExportFormat };
