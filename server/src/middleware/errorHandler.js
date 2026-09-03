import mongoose from 'mongoose';
import env from '../config/env.js';
import logger from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
}

/**
 * Terminal error handler.
 *
 * Maps known failure shapes to clean client responses and keeps internal
 * details (stack traces, driver messages) out of the response body in
 * production, where they would leak schema information.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity.
export function errorHandler(error, req, res, next) {
  // A malformed JSON body surfaces from body-parser as a SyntaxError.
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_JSON',
      message: 'Request body is not valid JSON.',
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large.',
    });
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const errors = Object.fromEntries(
      Object.entries(error.errors).map(([field, detail]) => [field, detail.message]),
    );
    return res.status(422).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Please correct the highlighted fields and try again.',
      errors,
    });
  }

  // A CastError means a value could not be coerced to its schema type. On this
  // service that is a server-side bug (a malformed filter), not bad user input
  // — user input is validated and coerced before it reaches Mongoose. Give it a
  // distinct code and log the path so it is diagnosable, but never echo the
  // offending value, which may carry PII.
  if (error instanceof mongoose.Error.CastError) {
    logger.error('request.query_cast_error', {
      path: error.path,
      kind: error.kind,
      valueType: typeof error.value,
      hint:
        'A filter failed to cast. If the path is a date and the value is an object, ' +
        'an operator such as { $gte: ... } is missing a mongoose.trusted() wrapper — ' +
        'sanitizeFilter rewrites untrusted operator objects to { $eq: ... }.',
    });
    return res.status(500).json({
      success: false,
      error: 'QUERY_CAST_ERROR',
      message: 'We could not process your request right now. Please try again.',
    });
  }

  // A duplicate-key error on this collection means someone added a unique index
  // that should not exist. Surface it unmistakably rather than as a 500.
  if (error.code === 11000) {
    logger.error('trial_request.unexpected_unique_index', {
      keyPattern: error.keyPattern,
      hint: 'trial_requests must not carry unique indexes on lead fields (notably email).',
    });
    return res.status(409).json({
      success: false,
      error: 'DUPLICATE_KEY',
      message: 'We could not save your request. Please contact us directly.',
    });
  }

  if (error instanceof mongoose.Error.MongooseServerSelectionError || error.name === 'MongoNetworkError') {
    logger.error('database.unavailable', { error: error.message });
    return res.status(503).json({
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: 'We could not save your request right now. Please try again in a moment.',
    });
  }

  logger.error('request.unhandled_error', {
    method: req.method,
    path: req.originalUrl,
    error: error.message,
    stack: error.stack,
  });

  return res.status(500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'Something went wrong on our end. Please try again.',
    ...(env.isProduction ? {} : { detail: error.message }),
  });
}
