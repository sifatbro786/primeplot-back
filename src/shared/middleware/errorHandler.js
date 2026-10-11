import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env } from '#config/env.js';
import {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '#shared/errors/AppError.js';

/** Map known library errors to AppError so the response shape is always the same. */
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new ValidationError(
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    );
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return new ValidationError(
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message, code: e.kind })),
    );
  }

  if (err instanceof mongoose.Error.CastError) {
    return new ValidationError([{ path: err.path, message: `Invalid ${err.kind}`, code: 'cast' }]);
  }

  // Duplicate key — report which field(s) without echoing the value back.
  if (err?.code === 11000) {
    const fields = Object.keys(err.keyPattern ?? err.keyValue ?? {}).filter((f) => f !== 'orgId');
    return new ConflictError('A record with the same value already exists', {
      code: 'DUPLICATE',
      details: fields.map((path) => ({ path, message: 'Already exists' })),
    });
  }

  if (err instanceof mongoose.Error.VersionError) {
    return new ConflictError('This record was changed by someone else. Reload and try again.', {
      code: 'STALE_VERSION',
    });
  }

  // body-parser errors (malformed JSON, payload too large, etc.) carry `status` + `type`.
  if (err?.type === 'entity.parse.failed') {
    return new AppError('Malformed JSON body', { statusCode: 400, code: 'INVALID_JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return new AppError('Request body too large', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  }

  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4).
export function errorHandler(err, req, res, next) {
  const appErr = normalize(err);
  const status = appErr?.statusCode ?? 500;

  if (status >= 500) {
    req.log?.error({ err }, 'Unhandled error');
  } else {
    req.log?.debug({ code: appErr.code, msg: appErr.message }, 'Request failed');
  }

  if (res.headersSent) return;

  res.status(status).json({
    success: false,
    error: {
      code: appErr?.code ?? 'INTERNAL_ERROR',
      message: appErr ? appErr.message : env.isProd ? 'Something went wrong' : err.message,
      ...(appErr?.details && { details: appErr.details }),
      requestId: req.id,
      ...(!env.isProd && status >= 500 && { stack: err.stack }),
    },
  });
}

export function notFound(req, res, next) {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
}
