import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '#config/env.js';

/**
 * One AUTH_SECRET, many purposes. Each purpose gets its own key via HKDF so a key used for
 * JWTs can never be replayed as, say, a token-hash pepper or an encryption key.
 */
const cache = new Map();
export function deriveKey(purpose) {
  let key = cache.get(purpose);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, 'primeplot.v1', purpose, 32));
    cache.set(purpose, key);
  }
  return key;
}

/** URL-safe random token (default 256 bits). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Keyed hash for storing bearer secrets (refresh tokens, reset links). A leaked DB alone is
 * not enough to forge a lookup hash.
 */
export function hashToken(token) {
  return createHmac('sha256', deriveKey('token-hash')).update(token).digest('base64url');
}

/** Constant-time string compare (false on length mismatch). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
