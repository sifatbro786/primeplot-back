import { BadRequestError } from '#shared/errors/AppError.js';

/**
 * Money endpoints accept an optional `Idempotency-Key` header (ARCHITECTURE §9): a retried
 * request with the same key returns the first result instead of booking/charging twice.
 * Sets req.idempotencyKey (string | null). 8–100 chars of [A-Za-z0-9_-] — a UUID fits.
 */
const KEY = /^[A-Za-z0-9_-]{8,100}$/;

export function idempotencyKey(req, res, next) {
  const raw = req.get('idempotency-key');
  if (raw === undefined || raw === '') {
    req.idempotencyKey = null;
    return next();
  }
  if (!KEY.test(raw)) {
    throw new BadRequestError('Invalid Idempotency-Key header', {
      code: 'INVALID_IDEMPOTENCY_KEY',
    });
  }
  req.idempotencyKey = raw;
  next();
}
