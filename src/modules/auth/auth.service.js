import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { fakeVerify, hashPassword, verifyPassword } from '#shared/crypto/password.js';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  TooManyRequestsError,
  UnauthorizedError,
} from '#shared/errors/AppError.js';
import { audit } from '#modules/audit/audit.service.js';
import { User } from '#modules/users/user.model.js';
import { queueEmail } from '#integrations/email/queue.js';
import { invalidateUser } from './authState.js';
import {
  consumeAuthToken,
  issueAuthToken,
  peekAuthToken,
  TOKEN_TTL_MS,
} from './authToken.service.js';
import { assertPasswordAllowed } from './passwordPolicy.js';
import {
  createSession,
  findSessionByRefreshToken,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
} from './session.service.js';
import { signAccessToken } from './token.service.js';

/**
 * Credentials live on the User document, so the auth module reads/writes those fields
 * directly; everything else about users goes through users/user.service.js.
 */
const log = logger.child({ module: 'auth' });

const MAX_FAILED = 5;
const LOCK_BASE_MIN = 15; // 15, 30, 60, 120, 240 min for repeated lockouts

const invalidCredentials = () =>
  new UnauthorizedError('Incorrect email or password', { code: 'INVALID_CREDENTIALS' });
const invalidLink = () =>
  new BadRequestError('This link is invalid or has expired', { code: 'INVALID_TOKEN' });

function lockedError(lockUntil) {
  const retryAfterSec = Math.max(1, Math.ceil((lockUntil - Date.now()) / 1000));
  return new TooManyRequestsError(
    `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
    { code: 'ACCOUNT_LOCKED', details: { retryAfterSec } },
  );
}

/** Count a wrong password; lock the account (exponentially longer each time) at MAX_FAILED. */
async function registerFailure(user, ctx) {
  const u = await User.findOneAndUpdate(
    { _id: user._id, orgId: user.orgId },
    { $inc: { failedLoginCount: 1 } },
    { returnDocument: 'after', projection: { failedLoginCount: 1, lockCount: 1 } },
  ).lean();
  if (!u || u.failedLoginCount < MAX_FAILED) return;

  const minutes = LOCK_BASE_MIN * 2 ** Math.min(u.lockCount ?? 0, 4);
  const lockUntil = new Date(Date.now() + minutes * 60_000);
  // Conditional: only one of several concurrent failures applies the lock.
  const res = await User.updateOne(
    { _id: user._id, orgId: user.orgId, failedLoginCount: { $gte: MAX_FAILED } },
    { $set: { failedLoginCount: 0, lockUntil }, $inc: { lockCount: 1 } },
  );
  if (res.modifiedCount) {
    log.warn({ userId: String(user._id), minutes }, 'Account locked after failed logins');
    await audit(ctx, 'auth.account_locked', {
      entity: { type: 'User', id: user._id },
      meta: { minutes },
    });
  }
}

function issueTokens(user, session) {
  return { accessToken: signAccessToken({ user, sessionId: session._id }) };
}

export async function login({ orgId, email, password, remember, ctx }) {
  const user = await User.findOne({ orgId, email }).select(
    '+passwordHash +failedLoginCount +lockCount +lockUntil',
  );

  // Unknown email and invited (no password yet) look exactly like a wrong password.
  if (!user || !user.passwordHash) {
    await fakeVerify(password);
    throw invalidCredentials();
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    await fakeVerify(password);
    throw lockedError(user.lockUntil);
  }

  const { ok, needsRehash } = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await registerFailure(user, { ...ctx, actor: { kind: 'anonymous' } });
    throw invalidCredentials();
  }
  // Only reveal "disabled" to someone who knows the password.
  if (user.status === 'disabled') {
    throw new ForbiddenError('This account has been disabled', { code: 'ACCOUNT_DISABLED' });
  }
  if (user.status !== 'active') throw invalidCredentials();

  user.failedLoginCount = 0;
  user.lockCount = 0;
  user.lockUntil = null;
  user.lastLoginAt = new Date();
  user.lastLoginIp = ctx.ip ?? null;
  if (needsRehash) user.passwordHash = await hashPassword(password);
  await user.save();

  const { session, refreshToken, refreshExpiresAt } = await createSession({
    user,
    remember,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  await audit(
    { ...ctx, actor: { id: user._id, role: user.role, name: user.name, kind: 'user' } },
    'auth.login',
    { entity: { type: 'User', id: user._id }, meta: { sessionId: String(session._id), remember } },
  );
  return { user, ...issueTokens(user, session), refreshToken, refreshExpiresAt };
}

export async function refresh({ orgId, refreshToken, ctx }) {
  const rotated = await rotateRefreshToken({
    orgId,
    refreshToken,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    onReuse: (s) =>
      audit({ ...ctx, actor: { kind: 'anonymous' } }, 'auth.refresh_reuse_detected', {
        entity: { type: 'User', id: s.userId },
        meta: { sessionId: String(s._id) },
      }),
  });
  const user = await User.findOne({ orgId, _id: rotated.session.userId }).lean();
  if (!user || user.status !== 'active') {
    await revokeSession({ orgId, sessionId: rotated.session._id, reason: 'user_disabled' });
    throw new UnauthorizedError('Please sign in again', { code: 'INVALID_REFRESH' });
  }
  return {
    user,
    ...issueTokens(user, rotated.session),
    refreshToken: rotated.refreshToken,
    refreshExpiresAt: rotated.refreshExpiresAt,
  };
}

/** Logout this device. Works with either the access session (req.user) or the refresh cookie. */
export async function logout({ orgId, sessionId, refreshToken, ctx }) {
  let sid = sessionId;
  if (!sid && refreshToken) sid = (await findSessionByRefreshToken({ orgId, refreshToken }))?._id;
  if (!sid) return;
  const revoked = await revokeSession({ orgId, sessionId: sid, reason: 'logout' });
  if (revoked && ctx.actor?.id) {
    await audit(ctx, 'auth.logout', { entity: { type: 'User', id: ctx.actor.id } });
  }
}

/** Sign out everywhere: kills every session and every outstanding access token. */
export async function logoutAll({ orgId, userId, ctx }) {
  await User.updateOne({ orgId, _id: userId }, { $inc: { authVersion: 1 } });
  invalidateUser(userId);
  const n = await revokeAllSessions({ orgId, userId, reason: 'logout_all' });
  await audit(ctx, 'auth.logout_all', {
    entity: { type: 'User', id: userId },
    meta: { sessions: n },
  });
}

/**
 * Always resolves (no account enumeration). Active users get a reset link; invited users who
 * never finished setup get a fresh setup link instead.
 */
export async function forgotPassword({ org, email, ctx }) {
  const user = await User.findOne({ orgId: org._id, email }).lean();
  if (!user || user.status === 'disabled') return;

  const purpose = user.status === 'invited' ? 'account_setup' : 'password_reset';
  const { token } = await issueAuthToken({ orgId: org._id, userId: user._id, purpose, ip: ctx.ip });
  const path = purpose === 'account_setup' ? 'setup-account' : 'reset-password';
  await queueEmail({
    orgId: org._id,
    to: user.email,
    template: purpose,
    locale: user.locale,
    sensitive: true,
    data: {
      name: user.name,
      orgName: org.name,
      url: `${env.CLIENT_URL}/${path}?token=${token}`,
      expiresMin: TOKEN_TTL_MS.password_reset / 60_000,
      expiresHours: TOKEN_TTL_MS.account_setup / 3_600_000,
    },
  });
  await audit({ ...ctx, actor: { kind: 'anonymous' } }, `auth.${purpose}_requested`, {
    entity: { type: 'User', id: user._id },
  });
}

/** For the reset/setup page: is the link still usable? Returns a masked email, never more. */
export async function inspectToken({ orgId, token, purpose }) {
  const t = await peekAuthToken({ orgId, token, purpose });
  if (!t) return { valid: false };
  const user = await User.findOne({ orgId, _id: t.userId }).select('email status').lean();
  if (!user || user.status === 'disabled') return { valid: false };
  const [local, domain] = user.email.split('@');
  return {
    valid: true,
    email: `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`,
    expiresAt: t.expiresAt,
  };
}

async function setPassword({ org, user, password, ctx, action }) {
  user.passwordHash = await hashPassword(password);
  user.passwordChangedAt = new Date();
  user.authVersion += 1;
  user.failedLoginCount = 0;
  user.lockCount = 0;
  user.lockUntil = null;
  if (user.status === 'invited') user.status = 'active';
  await user.save();
  invalidateUser(user._id);
  await revokeAllSessions({ orgId: org._id, userId: user._id, reason: 'password_changed' });
  await audit(
    { ...ctx, actor: { id: user._id, role: user.role, name: user.name, kind: 'user' } },
    action,
    { entity: { type: 'User', id: user._id } },
  );
}

async function consumeForUser({ org, token, purpose, password }) {
  // peek → load user → check password policy → consume atomically. A weak password or a
  // disabled user must not burn the link.
  const peek = await peekAuthToken({ orgId: org._id, token, purpose });
  if (!peek) throw invalidLink();
  const user = await User.findOne({ orgId: org._id, _id: peek.userId }).select(
    '+passwordHash +failedLoginCount +lockCount +lockUntil',
  );
  if (!user || user.status === 'disabled') throw invalidLink();
  if (purpose === 'account_setup' && user.status !== 'invited') throw invalidLink();
  assertPasswordAllowed(password, user);
  const consumed = await consumeAuthToken({ orgId: org._id, token, purpose });
  if (!consumed) throw invalidLink(); // lost a race with another submit
  return user;
}

export async function resetPassword({ org, token, password, ctx }) {
  const user = await consumeForUser({ org, token, purpose: 'password_reset', password });
  await setPassword({ org, user, password, ctx, action: 'auth.password_reset' });
  await queueEmail({
    orgId: org._id,
    to: user.email,
    template: 'password_changed',
    locale: user.locale,
    data: {
      name: user.name,
      orgName: org.name,
      when: new Date().toLocaleString('en-GB', {
        timeZone: org.settings?.timezone ?? 'Asia/Dhaka',
      }),
    },
  });
}

export async function setupAccount({ org, token, password, ctx }) {
  const user = await consumeForUser({ org, token, purpose: 'account_setup', password });
  await setPassword({ org, user, password, ctx, action: 'auth.account_setup' });
}

/**
 * Change password while signed in. Every other session is revoked; the current one survives
 * with a fresh access token (authVersion changed).
 */
export async function changePassword({
  org,
  userId,
  sessionId,
  currentPassword,
  newPassword,
  ctx,
}) {
  const user = await User.findOne({ orgId: org._id, _id: userId }).select(
    '+passwordHash +failedLoginCount +lockCount +lockUntil',
  );
  if (!user) throw new UnauthorizedError();
  if (user.lockUntil && user.lockUntil > new Date()) throw lockedError(user.lockUntil);

  const { ok } = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    await registerFailure(user, ctx);
    throw new AppError('Current password is incorrect', {
      statusCode: 400,
      code: 'INVALID_CURRENT_PASSWORD',
    });
  }
  if (currentPassword === newPassword) {
    throw new BadRequestError('New password must be different', { code: 'PASSWORD_UNCHANGED' });
  }
  assertPasswordAllowed(newPassword, user);

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.authVersion += 1;
  user.failedLoginCount = 0;
  await user.save();
  invalidateUser(user._id);
  await revokeAllSessions({
    orgId: org._id,
    userId: user._id,
    reason: 'password_changed',
    exceptSessionId: sessionId,
  });
  await audit(ctx, 'auth.password_change', { entity: { type: 'User', id: user._id } });
  await queueEmail({
    orgId: org._id,
    to: user.email,
    template: 'password_changed',
    locale: user.locale,
    data: {
      name: user.name,
      orgName: org.name,
      when: new Date().toLocaleString('en-GB', {
        timeZone: org.settings?.timezone ?? 'Asia/Dhaka',
      }),
    },
  });
  return { accessToken: signAccessToken({ user, sessionId }) };
}
