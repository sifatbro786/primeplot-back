import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
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

/**
 * AES-256-GCM for secrets we must read back (e.g. the Meta Page token). The key is derived from
 * AUTH_SECRET per purpose; `purpose` is also bound as AAD, so a value encrypted for one purpose
 * never decrypts under another. Format: "v1.<iv>.<tag>.<ciphertext>" (base64url).
 * Rotating AUTH_SECRET makes stored values unreadable → reconnect the integration.
 */
export function encryptSecret(plain, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(`enc:${purpose}`), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** Inverse of encryptSecret(); returns null when the value is missing, tampered or from another key. */
export function decryptSecret(value, purpose) {
  if (typeof value !== 'string') return null;
  const [v, iv, tag, ct] = value.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      deriveKey(`enc:${purpose}`),
      Buffer.from(iv, 'base64url'),
    );
    d.setAAD(Buffer.from(purpose));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
