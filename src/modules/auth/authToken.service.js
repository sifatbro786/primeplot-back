import { hashToken, randomToken } from '#shared/crypto/secrets.js';
import { AuthToken } from './authToken.model.js';

export const TOKEN_TTL_MS = Object.freeze({
  password_reset: 30 * 60_000, // 30 min
  account_setup: 72 * 3_600_000, // 72 h
});

/** Issue a single-use token; any earlier unused token for the same user+purpose dies. */
export async function issueAuthToken({ orgId, userId, purpose, createdBy = null, ip = null }) {
  await AuthToken.deleteMany({ orgId, userId, purpose, usedAt: null });
  const token = randomToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[purpose]);
  await AuthToken.create({
    orgId,
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt,
    createdBy,
    ip,
  });
  return { token, expiresAt };
}

const looksValid = (token) => typeof token === 'string' && /^[\w-]{43}$/.test(token);

/** Atomically burn a token. Returns the token doc, or null if unknown/used/expired. */
export async function consumeAuthToken({ orgId, token, purpose }) {
  if (!looksValid(token)) return null;
  return AuthToken.findOneAndUpdate(
    { orgId, tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: 'after', lean: true },
  );
}

/** Check without consuming (lets the UI show "link expired" before the user types a password). */
export async function peekAuthToken({ orgId, token, purpose }) {
  if (!looksValid(token)) return null;
  return AuthToken.findOne({
    orgId,
    tokenHash: hashToken(token),
    purpose,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
}
