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
