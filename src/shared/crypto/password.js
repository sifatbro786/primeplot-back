import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * Password hashing with Node's built-in scrypt — no native addon to compile on Windows/VPS.
 * Params follow OWASP's scrypt guidance (N=2^15, r=8, p=3 → ~32 MB per hash). scrypt runs on
 * the libuv threadpool (4 threads), so peak memory under a login burst is bounded (~128 MB).
 *
 * Stored format: scrypt$<logN>$<r>$<p>$<salt b64url>$<hash b64url>
 */
const PARAMS = Object.freeze({ logN: 15, r: 8, p: 3 });
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128; // bounds hashing cost (long-password DoS)

async function derive(password, salt, { logN, r, p }) {
  return scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: 2 ** logN, r, p, maxmem: MAXMEM });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  const { logN, r, p } = PARAMS;
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function parse(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, logN, r, p, salt, hash] = parts;
  return {
    params: { logN: Number(logN), r: Number(r), p: Number(p) },
    salt: Buffer.from(salt, 'base64url'),
    hash: Buffer.from(hash, 'base64url'),
  };
}

// Verified against when the user does not exist, so "unknown email" costs the same time as
// "wrong password" (no account enumeration by timing).
let dummyHash;
async function getDummy() {
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

/** @returns {Promise<{ ok: boolean, needsRehash: boolean }>} */
export async function verifyPassword(password, stored) {
  const parsed = parse(stored ?? (await getDummy()));
  if (!parsed || typeof password !== 'string' || password.length > PASSWORD_MAX) {
    return { ok: false, needsRehash: false };
  }
  const candidate = await derive(password, parsed.salt, parsed.params);
  const ok =
    stored != null &&
    candidate.length === parsed.hash.length &&
    timingSafeEqual(candidate, parsed.hash);
  const needsRehash =
    ok &&
    (parsed.params.logN !== PARAMS.logN ||
      parsed.params.r !== PARAMS.r ||
      parsed.params.p !== PARAMS.p);
  return { ok, needsRehash };
}

/** Burn the same CPU as a real check (used when the account doesn't exist). */
export async function fakeVerify(password) {
  await verifyPassword(String(password ?? '').slice(0, PASSWORD_MAX), null);
}
