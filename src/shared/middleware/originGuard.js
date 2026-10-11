import { env } from '#config/env.js';
import { ForbiddenError } from '#shared/errors/AppError.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence-in-depth on top of SameSite cookies: a state-changing request that carries an
 * Origin header must come from an allowed origin. Requests without Origin (server-to-server,
 * curl, the Next.js server) pass — they can't ride a victim's browser cookies.
 * Mount AFTER webhook/callback routes that are legitimately cross-origin (Meta, SSLCommerz).
 */
export function originGuard(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  // 'null' = sandboxed iframe / file:// / opaque redirect → never trusted.
  if (origin !== 'null' && env.corsOrigins.includes(origin)) return next();
  next(new ForbiddenError('Cross-origin request blocked', { code: 'BAD_ORIGIN' }));
}
