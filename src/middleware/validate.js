'use strict';

const { ValidationError } = require('../core/errors');

/**
 * Builds a middleware that validates one part of the request against a Zod
 * schema and replaces it with the parsed result.
 *
 * Replacing rather than merging is the important part: the handler downstream
 * sees only fields the schema declared. An attacker cannot smuggle an extra
 * property such as `type: "ORG"` or `role: "OWNER"` into a payload and have it
 * reach a model, which is the mass assignment class of bug.
 *
 * @param {import('zod').ZodType} schema Schema to apply.
 * @param {'body'|'query'|'params'} [source] Request property to validate.
 * @returns {Function} Express middleware.
 */
function validate(schema, source = 'body') {
  return function validateRequest(req, res, next) {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      next(new ValidationError('The submitted data failed validation.', details));
      return;
    }

    // `req.query` and `req.params` are getter only on Express 5, so the parsed
    // value is stored alongside rather than assigned back.
    if (source === 'body') {
      req.body = result.data;
    } else {
      req.validated = { ...(req.validated ?? {}), [source]: result.data };
    }

    next();
  };
}

/**
 * Reads a validated value, falling back to the raw request property.
 *
 * @param {import('express').Request} req Request.
 * @param {'query'|'params'} source Request property.
 * @returns {object} Validated data.
 */
function validated(req, source) {
  return req.validated?.[source] ?? req[source];
}

module.exports = { validate, validated };
