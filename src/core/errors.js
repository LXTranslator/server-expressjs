'use strict';

/**
 * Application error taxonomy.
 *
 * Only errors created here are considered "expected". The global error handler
 * returns their message to the client verbatim; anything else is reported as a
 * generic failure so internal details never leak.
 */
class AppError extends Error {
  /**
   * @param {string} message Client safe message.
   * @param {number} statusCode HTTP status code.
   * @param {string} code Stable machine readable code.
   * @param {object|null} [details] Optional structured detail, must be client safe.
   */
  constructor(message, statusCode, code, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'The request was malformed.', details = null) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

class ValidationError extends AppError {
  constructor(message = 'The submitted data failed validation.', details = null) {
    super(message, 422, 'VALIDATION_FAILED', details);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required.', details = null) {
    super(message, 401, 'UNAUTHORIZED', details);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.', details = null) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.', details = null) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

class ConflictError extends AppError {
  constructor(message = 'The resource already exists.', details = null) {
    super(message, 409, 'CONFLICT', details);
  }
}

class PayloadTooLargeError extends AppError {
  constructor(message = 'The payload is larger than the configured limit.', details = null) {
    super(message, 413, 'PAYLOAD_TOO_LARGE', details);
  }
}

class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'The media type is not supported.', details = null) {
    super(message, 415, 'UNSUPPORTED_MEDIA_TYPE', details);
  }
}

class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests. Try again later.', details = null) {
    super(message, 429, 'TOO_MANY_REQUESTS', details);
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable.', details = null) {
    super(message, 503, 'SERVICE_UNAVAILABLE', details);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  TooManyRequestsError,
  ServiceUnavailableError,
};
