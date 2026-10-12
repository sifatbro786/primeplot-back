import jwt from 'jsonwebtoken';
import { env } from '#config/env.js';
import { deriveKey } from '#shared/crypto/secrets.js';
import { UnauthorizedError } from '#shared/errors/AppError.js';

const ISSUER = 'primeplot-api';
const AUDIENCE = 'primeplot';
const ALG = 'HS256';

/** Access token: short-lived, stateless except for the authVersion check in authenticate(). */
export function signAccessToken({ user, sessionId }) {
  return jwt.sign(
    {
      org: String(user.orgId),
      role: user.role,
      sid: String(sessionId),
      av: user.authVersion ?? 0,
    },
    deriveKey('jwt-access'),
    {
      algorithm: ALG,
      subject: String(user._id),
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60,
    },
  );
}

export function verifyAccessToken(token) {
  try {
    // Algorithm pinned: rejects `alg: none` and RS/HS confusion.
    return jwt.verify(token, deriveKey('jwt-access'), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    throw new UnauthorizedError(expired ? 'Session expired' : 'Invalid session', {
      code: expired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED',
    });
  }
}

/**
 * Socket token (B2): Socket.IO connects to the API host directly (WebSockets can't ride the
 * Next.js rewrite), so the HttpOnly access cookie isn't sent. The page asks
 * POST /auth/socket-token (same-origin, cookie-authenticated) for a 60-second token and passes
 * it in the handshake `auth` payload. Separate key + audience: it can never be used as an
 * access token, and vice versa.
 */
const SOCKET_AUDIENCE = 'primeplot-socket';
export const SOCKET_TOKEN_TTL_SEC = 60;

export function signSocketToken({ user, orgId }) {
  return jwt.sign({ org: String(orgId), av: user.authVersion ?? 0 }, deriveKey('jwt-socket'), {
    algorithm: ALG,
    subject: String(user.id),
    issuer: ISSUER,
    audience: SOCKET_AUDIENCE,
    expiresIn: SOCKET_TOKEN_TTL_SEC,
  });
}

export function verifySocketToken(token) {
  try {
    return jwt.verify(token, deriveKey('jwt-socket'), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: SOCKET_AUDIENCE,
    });
  } catch {
    throw new UnauthorizedError('Invalid socket token', { code: 'INVALID_SOCKET_TOKEN' });
  }
}
