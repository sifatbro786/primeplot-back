/**
 * In-process auth state (single PM2 instance — ARCHITECTURE §6.3):
 *  - a short-TTL cache of the fields authenticate() needs, so a valid request costs no DB
 *    round-trip to Atlas most of the time;
 *  - a set of session ids revoked in the last access-token lifetime, so "log out that device"
 *    takes effect at once instead of after up to 15 minutes.
 * Both are invalidated explicitly on every write that matters (role/status/authVersion).
 * After a restart they are simply empty: the cache refills from the DB, and the revoked set
 * loses at most one access-token lifetime of early revocation (refresh is always DB-checked).
 */
import { env } from '#config/env.js';

const USER_TTL_MS = 30_000;
const users = new Map(); // userId → { value, at }
const revoked = new Map(); // sessionId → expiresAtMs

export function getCachedUser(userId) {
  const hit = users.get(userId);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.value;
  users.delete(userId);
  return null;
}

export function cacheUser(userId, value) {
  if (users.size > 5000) users.clear(); // crude bound; staff/client counts are small
  users.set(userId, { value, at: Date.now() });
}

export function invalidateUser(userId) {
  users.delete(String(userId));
}

export function markSessionRevoked(sessionId) {
  const now = Date.now();
  revoked.set(String(sessionId), now + env.ACCESS_TOKEN_TTL_MIN * 60_000);
  if (revoked.size > 1000) {
    for (const [sid, exp] of revoked) if (exp < now) revoked.delete(sid);
  }
}

export function isSessionRevoked(sessionId) {
  const exp = revoked.get(sessionId);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    revoked.delete(sessionId);
    return false;
  }
  return true;
}

/** Tests only. */
export function _resetAuthState() {
  users.clear();
  revoked.clear();
}
