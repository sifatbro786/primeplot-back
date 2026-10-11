/**
 * Operational errors — expected failures that map to an HTTP response.
 * Anything that is NOT an AppError is treated as a bug (500, message hidden in production).
 */
export class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', opts = {}) {
    super(message, { statusCode: 400, code: 'BAD_REQUEST', ...opts });
  }
}

export class ValidationError extends AppError {
  constructor(details, message = 'Validation failed') {
    super(message, { statusCode: 422, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', opts = {}) {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED', ...opts });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', opts = {}) {
    super(message, { statusCode: 403, code: 'FORBIDDEN', ...opts });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', opts = {}) {
    super(message, { statusCode: 404, code: 'NOT_FOUND', ...opts });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', opts = {}) {
    super(message, { statusCode: 409, code: 'CONFLICT', ...opts });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later', opts = {}) {
    super(message, { statusCode: 429, code: 'RATE_LIMITED', ...opts });
  }
}
