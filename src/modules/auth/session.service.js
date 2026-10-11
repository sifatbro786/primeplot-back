import mongoose from 'mongoose';
import { env } from '#config/env.js';
import { hashToken, randomToken, safeEqual } from '#shared/crypto/secrets.js';
import { AppError, UnauthorizedError } from '#shared/errors/AppError.js';
import { Session } from './session.model.js';
import { markSessionRevoked } from './authState.js';

const DAY = 86_400_000;
const PURGE_AFTER_MS = 7 * DAY;
const MAX_ACTIVE_SESSIONS = 10;
// Two tabs refreshing at the same moment both send the same (old) cookie. The loser gets a
// retryable 409 instead of being treated as a thief.
const ROTATION_GRACE_MS = 30_000;

const idleTtl = (remember) =>
  (remember ? env.REFRESH_REMEMBER_TTL_DAYS : env.REFRESH_TOKEN_TTL_DAYS) * DAY;

function parseRefreshToken(token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const [sid, secret, extra] = token.split('.');
  if (extra !== undefined || !mongoose.isValidObjectId(sid) || !/^[\w-]{43}$/.test(secret ?? '')) {
    return null;
  }
  return { sid, secret };
}

const invalid = (code = 'INVALID_REFRESH', message = 'Please sign in again') =>
  new UnauthorizedError(message, { code });

export async function createSession({ user, remember = false, ip, userAgent }) {
  const now = Date.now();
  const secret = randomToken();
  const absoluteExpiresAt = new Date(now + env.SESSION_ABSOLUTE_TTL_DAYS * DAY);
  const expiresAt = new Date(Math.min(now + idleTtl(remember), absoluteExpiresAt.getTime()));

  const session = await Session.create({
    orgId: user.orgId,
    userId: user._id,
    tokenHash: hashToken(secret),
    remember,
    expiresAt,
    absoluteExpiresAt,
    lastUsedAt: new Date(now),
    ip: ip ?? null,
    userAgent: userAgent?.slice(0, 400) ?? null,
    purgeAt: new Date(absoluteExpiresAt.getTime() + PURGE_AFTER_MS),
  });

  await trimSessions(user.orgId, user._id);
  return { session, refreshToken: `${session._id}.${secret}`, refreshExpiresAt: expiresAt };
}

/** Keep at most MAX_ACTIVE_SESSIONS per user — revoke the least recently used beyond that. */
async function trimSessions(orgId, userId) {
  const active = await Session.find({
    orgId,
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .select('_id')
    .lean();
  const extra = active.slice(MAX_ACTIVE_SESSIONS).map((s) => s._id);
  if (extra.length) {
    await Session.updateMany(
      { orgId, _id: { $in: extra } },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
    extra.forEach(markSessionRevoked);
  }
}

/**
 * Rotate a refresh token. Returns the session plus the new token, or throws:
 *  401 INVALID_REFRESH / SESSION_EXPIRED / REFRESH_REUSED, 409 REFRESH_SUPERSEDED (retry).
 * `onReuse(session)` is called when theft is detected (for auditing).
 */
export async function rotateRefreshToken({ orgId, refreshToken, ip, userAgent, onReuse }) {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) throw invalid();

  const presentedHash = hashToken(parsed.secret);
  let session = await Session.findOne({ _id: parsed.sid, orgId }).lean();
  if (!session || session.revokedAt) throw invalid();

  const now = new Date();
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
    throw invalid('SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }

  if (safeEqual(session.tokenHash, presentedHash)) {
    const secret = randomToken();
    const expiresAt = new Date(
      Math.min(now.getTime() + idleTtl(session.remember), session.absoluteExpiresAt.getTime()),
    );
    // Compare-and-swap on the current hash: exactly one concurrent refresh wins.
    const updated = await Session.findOneAndUpdate(
      { _id: session._id, orgId, tokenHash: presentedHash, revokedAt: null },
      {
        $set: {
          tokenHash: hashToken(secret),
          prevTokenHash: presentedHash,
          rotatedAt: now,
          lastUsedAt: now,
          expiresAt,
          ip: ip ?? session.ip,
          userAgent: userAgent?.slice(0, 400) ?? session.userAgent,
        },
      },
      { returnDocument: 'after', lean: true },
    );
    if (updated) {
      return {
        session: updated,
        refreshToken: `${updated._id}.${secret}`,
        refreshExpiresAt: expiresAt,
      };
    }
    // Lost the race — re-read and fall through to the grace check.
    session = await Session.findOne({ _id: parsed.sid, orgId }).lean();
    if (!session || session.revokedAt) throw invalid();
  }

  const recentlyRotated =
    session.prevTokenHash &&
    safeEqual(session.prevTokenHash, presentedHash) &&
    session.rotatedAt &&
    now - session.rotatedAt < ROTATION_GRACE_MS;
  if (recentlyRotated) {
    throw new AppError('Session was refreshed by another request — retry', {
      statusCode: 409,
      code: 'REFRESH_SUPERSEDED',
    });
  }

  // An old token came back after it was rotated: someone else has a copy. Kill the family.
  await revokeSession({ orgId, sessionId: session._id, reason: 'reuse_detected' });
  await onReuse?.(session);
  throw invalid('REFRESH_REUSED', 'For your security, please sign in again.');
}

/** Resolve a refresh token to its session without rotating (logout). Returns null if invalid. */
export async function findSessionByRefreshToken({ orgId, refreshToken }) {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return null;
  const s = await Session.findOne({ _id: parsed.sid, orgId, revokedAt: null }).lean();
  return s && safeEqual(s.tokenHash, hashToken(parsed.secret)) ? s : null;
}

export async function revokeSession({ orgId, sessionId, userId, reason }) {
  const filter = { orgId, _id: sessionId, revokedAt: null };
  if (userId) filter.userId = userId; // object-level check when a user revokes "their" session
  const res = await Session.updateOne(filter, {
    $set: { revokedAt: new Date(), revokedReason: reason },
  });
  if (res.modifiedCount) markSessionRevoked(sessionId);
  return res.modifiedCount > 0;
}

export async function revokeAllSessions({ orgId, userId, reason, exceptSessionId }) {
  const filter = { orgId, userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const ids = (await Session.find(filter).select('_id').lean()).map((s) => s._id);
  if (!ids.length) return 0;
  await Session.updateMany(
    { orgId, _id: { $in: ids } },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  ids.forEach(markSessionRevoked);
  return ids.length;
}

export async function listSessions({ orgId, userId, currentSessionId }) {
  const rows = await Session.find({
    orgId,
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .lean();
  return rows.map((s) => ({
    id: String(s._id),
    current: String(s._id) === String(currentSessionId),
    ip: s.ip,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
    remember: s.remember,
  }));
}
