import { env } from '#config/env.js';
import { permissionsFor } from '#shared/auth/permissions.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { offsetMeta } from '#shared/utils/pagination.js';
import { normalizeBdPhone } from '#shared/utils/phone.js';
import { audit } from '#modules/audit/audit.service.js';
import { invalidateUser } from '#modules/auth/authState.js';
import { issueAuthToken, TOKEN_TTL_MS } from '#modules/auth/authToken.service.js';
import { revokeAllSessions } from '#modules/auth/session.service.js';
import { queueEmail } from '#integrations/email/queue.js';
import { User } from './user.model.js';

export function toPublicUser(u, { withPermissions = false } = {}) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    role: u.role,
    status: u.status,
    locale: u.locale,
    avatarMediaId: u.avatarMediaId ? String(u.avatarMediaId) : null,
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
    ...(withPermissions && { permissions: [...permissionsFor(u.role)].sort() }),
  };
}

function phoneOrThrow(phone) {
  if (phone == null || phone === '') return null;
  const e164 = normalizeBdPhone(phone);
  if (!e164)
    throw new BadRequestError('Invalid Bangladesh mobile number', { code: 'INVALID_PHONE' });
  return e164;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listUsers(orgId, { q, role, status, page, limit }) {
  const filter = { orgId };
  if (role) filter.role = role;
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    const phone = normalizeBdPhone(q);
    filter.$or = [{ name: rx }, { email: rx }, ...(phone ? [{ phone }] : [])];
  }
  const [rows, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);
  return { items: rows.map((u) => toPublicUser(u)), meta: offsetMeta({ page, limit }, total) };
}

export async function getUser(orgId, id) {
  const u = await User.findOne({ orgId, _id: id }).lean();
  if (!u) throw new NotFoundError('User not found');
  return u;
}

async function sendSetupLink({ org, user, actorId, ip }) {
  const { token } = await issueAuthToken({
    orgId: org._id,
    userId: user._id,
    purpose: 'account_setup',
    createdBy: actorId,
    ip,
  });
  await queueEmail({
    orgId: org._id,
    to: user.email,
    template: 'account_setup',
    locale: user.locale,
    sensitive: true,
    data: {
      name: user.name,
      orgName: org.name,
      url: `${env.CLIENT_URL}/setup-account?token=${token}`,
      expiresHours: TOKEN_TTL_MS.account_setup / 3_600_000,
    },
  });
}

/** Admin creates a user → status `invited` + account-setup email (72 h link). */
export async function createUser({ org, input, ctx }) {
  const user = await User.create({
    orgId: org._id,
    name: input.name,
    email: input.email,
    phone: phoneOrThrow(input.phone),
    role: input.role,
    locale: input.locale ?? org.settings?.defaultLocale ?? 'bn',
    status: 'invited',
    invitedBy: ctx.actor.id ?? null,
  });
  await sendSetupLink({ org, user, actorId: ctx.actor.id, ip: ctx.ip });
  await audit(ctx, 'user.create', {
    entity: { type: 'User', id: user._id },
    meta: { role: user.role, email: user.email },
  });
  return user.toObject();
}

export async function resendInvite({ org, id, ctx }) {
  const user = await getUser(org._id, id);
  if (user.status !== 'invited') {
    throw new ConflictError('User has already activated the account', { code: 'ALREADY_ACTIVE' });
  }
  await sendSetupLink({ org, user, actorId: ctx.actor.id, ip: ctx.ip });
  await audit(ctx, 'user.invite_resent', { entity: { type: 'User', id: user._id } });
}

async function assertNotLastAdmin(orgId, userId) {
  const others = await User.countDocuments({
    orgId,
    role: 'admin',
    status: 'active',
    _id: { $ne: userId },
  });
  if (others === 0) {
    throw new ConflictError('At least one active admin must remain', { code: 'LAST_ADMIN' });
  }
}

/**
 * Admin edit. Role or status changes bump authVersion (every token of that user dies at once)
 * and revoke their sessions.
 */
export async function updateUser({ orgId, id, patch, ctx }) {
  const user = await User.findOne({ orgId, _id: id });
  if (!user) throw new NotFoundError('User not found');
  const before = user.toObject();
  const isSelf = String(user._id) === String(ctx.actor.id);

  const roleChange = patch.role !== undefined && patch.role !== user.role;
  const statusChange = patch.status !== undefined && patch.status !== user.status;

  if (isSelf && (roleChange || statusChange)) {
    throw new ForbiddenError('You cannot change your own role or status', { code: 'SELF_CHANGE' });
  }
  if (statusChange && user.status === 'invited' && patch.status === 'active') {
    throw new BadRequestError('Invited users activate themselves via the setup link', {
      code: 'INVITE_PENDING',
    });
  }
  if (
    user.role === 'admin' &&
    user.status === 'active' &&
    ((roleChange && patch.role !== 'admin') || (statusChange && patch.status === 'disabled'))
  ) {
    await assertNotLastAdmin(orgId, user._id);
  }

  if (patch.name !== undefined) user.name = patch.name;
  if (patch.phone !== undefined) user.phone = phoneOrThrow(patch.phone);
  if (patch.locale !== undefined) user.locale = patch.locale;
  if (roleChange) user.role = patch.role;
  if (statusChange) user.status = patch.status;
  if (roleChange || statusChange) user.authVersion += 1;

  await user.save();
  invalidateUser(user._id);

  if (roleChange || statusChange) {
    await revokeAllSessions({
      orgId,
      userId: user._id,
      reason: statusChange && user.status === 'disabled' ? 'user_disabled' : 'admin',
    });
  }

  const diff = diffFields(before, user.toObject(), ['name', 'phone', 'locale', 'role', 'status']);
  if (diff) await audit(ctx, 'user.update', { entity: { type: 'User', id: user._id }, diff });
  return user.toObject();
}

/** Self-service profile edit (name, phone, locale). */
export async function updateOwnProfile({ orgId, userId, patch, ctx }) {
  const user = await User.findOne({ orgId, _id: userId });
  if (!user) throw new NotFoundError('User not found');
  const before = user.toObject();
  if (patch.name !== undefined) user.name = patch.name;
  if (patch.phone !== undefined) user.phone = phoneOrThrow(patch.phone);
  if (patch.locale !== undefined) user.locale = patch.locale;
  await user.save();
  invalidateUser(user._id);
  const diff = diffFields(before, user.toObject(), ['name', 'phone', 'locale']);
  if (diff)
    await audit(ctx, 'user.profile_update', { entity: { type: 'User', id: user._id }, diff });
  return user.toObject();
}
