import { permissionsFor } from '#shared/auth/permissions.js';
import { ForbiddenError, UnauthorizedError } from '#shared/errors/AppError.js';
import { User } from '#modules/users/user.model.js';
import { ACCESS_COOKIE } from './auth.cookies.js';
import { verifyAccessToken } from './token.service.js';
import { cacheUser, getCachedUser, isSessionRevoked } from './authState.js';

function readToken(req) {
  const cookie = req.cookies?.[ACCESS_COOKIE];
  if (cookie) return cookie;
  // Bearer is accepted for API tooling (Postman) and server-side calls; browsers use the cookie.
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function loadAuthUser(userId, orgId) {
  const cached = getCachedUser(userId);
  if (cached) return cached;
  const u = await User.findOne({ _id: userId, orgId })
    .select('name email role status authVersion locale')
    .lean();
  if (!u) return null;
  const value = {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    authVersion: u.authVersion ?? 0,
    locale: u.locale,
  };
  cacheUser(userId, value);
  return value;
}

/** Requires a valid access token. Sets req.user = { id, orgId, role, name, email, sessionId, permissions }. */
export async function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) throw new UnauthorizedError();

  const claims = verifyAccessToken(token);
  if (claims.org !== String(req.orgId)) throw new UnauthorizedError('Invalid session');
  if (isSessionRevoked(claims.sid)) {
    throw new UnauthorizedError('Session ended', { code: 'SESSION_REVOKED' });
  }

  const user = await loadAuthUser(claims.sub, req.orgId);
  if (!user || user.status !== 'active' || user.authVersion !== claims.av) {
    throw new UnauthorizedError('Session is no longer valid', { code: 'SESSION_INVALIDATED' });
  }

  req.user = {
    ...user,
    orgId: req.orgId,
    sessionId: claims.sid,
    permissions: permissionsFor(user.role),
  };
  next();
}

/** Requires ALL listed permissions. Use after authenticate. */
export function authorize(...permissions) {
  return (req, res, next) => {
    if (!req.user) throw new UnauthorizedError();
    const missing = permissions.filter((p) => !req.user.permissions.has(p));
    if (missing.length) throw new ForbiddenError(undefined, { details: { missing } });
    next();
  };
}

/** Requires ANY of the listed permissions. */
export function authorizeAny(...permissions) {
  return (req, res, next) => {
    if (!req.user) throw new UnauthorizedError();
    if (!permissions.some((p) => req.user.permissions.has(p))) throw new ForbiddenError();
    next();
  };
}
