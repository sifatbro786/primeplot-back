import mongoose from 'mongoose';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { toBdMsisdn } from '#integrations/sms/index.js';
import { queueEmail } from '#integrations/email/queue.js';
import { ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { audit, SYSTEM_ACTOR } from '#modules/audit/audit.service.js';
import { invalidateUser } from '#modules/auth/authState.js';
import { maskEmail, maskPhone, sendAuthLink } from '#modules/auth/authLinks.js';
import { AuthToken } from '#modules/auth/authToken.model.js';
import { revokeAllSessions } from '#modules/auth/session.service.js';
import { getAccountSettings, portalSettingsOf } from '#modules/accounts/accounts.service.js';
import { Customer } from '#modules/customers/customer.model.js';
import { queueSms } from '#modules/sms/sms.service.js';
import { User } from '#modules/users/user.model.js';

/**
 * Client logins for the customer portal (B5.1, owner decisions 2026-10-15).
 *
 *  - One login (role `client`) per customer; `customer.portalUserId` ↔ `user.customerId`.
 *  - It signs in with the phone number or, when the customer has one, the e-mail address.
 *  - Created automatically for the holder when a booking is made or a unit is transferred to
 *    them (setting `portal.autoInvite`); co-applicants are invited by staff (or automatically
 *    with `portal.autoInviteCoApplicants`). The setup link goes by SMS and e-mail (72 h);
 *    "forgot password" with the phone sends a fresh one later.
 *  - The customer's phone / e-mail / name stay the source of truth; the login follows them.
 *
 * Nothing here ever fails the caller's business action: callers use `safeInvite`.
 */
const log = logger.child({ module: 'portal-accounts' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

/** Resend throttle: one fresh setup link per customer per 10 minutes (staff can `force`). */
const RESEND_GAP_MS = 10 * 60_000;

/** Status card shown on the customer page (staff). */
export async function portalStatus(orgId, customer) {
  if (!customer.portalUserId) return { status: 'none', userId: null };
  const u = await User.findOne({ orgId, _id: customer.portalUserId })
    .select('status email phone lastLoginAt createdAt')
    .lean();
  if (!u) return { status: 'none', userId: null };
  const lastLink = await AuthToken.findOne({ orgId, userId: u._id, purpose: 'account_setup' })
    .sort({ createdAt: -1 })
    .select('createdAt expiresAt usedAt')
    .lean();
  return {
    status: u.status, // invited | active | disabled
    userId: String(u._id),
    login: { email: maskEmail(u.email), phone: maskPhone(u.phone) },
    lastLoginAt: u.lastLoginAt ?? null,
    inviteSentAt: lastLink?.createdAt ?? null,
    inviteExpiresAt: lastLink && !lastLink.usedAt ? lastLink.expiresAt : null,
  };
}

/** An e-mail the login may use: the customer's, unless another login of this org owns it. */
async function freeEmail(orgId, email, exceptUserId) {
  if (!email) return null;
  const taken = await User.exists({
    orgId,
    email,
    ...(exceptUserId && { _id: { $ne: oid(exceptUserId) } }),
  });
  return taken ? null : email;
}

async function createLogin(org, c, invitedBy) {
  const user = await User.create({
    orgId: org._id,
    name: c.name,
    email: await freeEmail(org._id, c.email),
    phone: c.phone,
    role: 'client',
    status: 'invited',
    locale: c.locale ?? org.settings?.defaultLocale ?? 'bn',
    customerId: c._id,
    invitedBy: invitedBy ? oid(invitedBy) : null,
  }).catch(async (err) => {
    // The customer's e-mail was taken between the check and the insert: go phone-only.
    if (err?.code === 11000 && err.keyPattern?.email) {
      return User.create({
        orgId: org._id,
        name: c.name,
        email: null,
        phone: c.phone,
        role: 'client',
        status: 'invited',
        locale: c.locale ?? org.settings?.defaultLocale ?? 'bn',
        customerId: c._id,
        invitedBy: invitedBy ? oid(invitedBy) : null,
      });
    }
    throw err;
  });
  // Two bookings for the same customer at the same moment: the first link wins.
  const linked = await Customer.updateOne(
    { orgId: org._id, _id: c._id, portalUserId: null },
    { $set: { portalUserId: user._id } },
  );
  if (!linked.modifiedCount) {
    await User.collection.deleteOne({ _id: user._id, orgId: org._id });
    const fresh = await Customer.findOne({ orgId: org._id, _id: c._id }).lean();
    return {
      user: await User.findOne({ orgId: org._id, _id: fresh.portalUserId }).lean(),
      created: false,
    };
  }
  return { user: user.toObject(), created: true };
}

/**
 * Make sure a customer has a portal login and, if it isn't active yet, send the setup link.
 * @returns {{ status, userId, created, sent: { sms, email }, reason? }}
 *   reason: 'disabled' | 'no_channel' | 'recently_sent' | 'already_active'
 */
export async function invitePortalUser({ org, customerId, by = null, force = false, ctx }) {
  const orgId = org._id;
  const c = await Customer.findOne({ orgId, _id: customerId }).lean();
  if (!c) throw new NotFoundError('Customer not found');
  const settings = portalSettingsOf(await getAccountSettings(orgId));
  const channels = { sms: settings.inviteSms, email: settings.inviteEmail };

  let user = c.portalUserId ? await User.findOne({ orgId, _id: c.portalUserId }).lean() : null;
  let created = false;
  if (!user) ({ user, created } = await createLogin(org, c, by?.id));

  const result = (extra) => ({ status: user.status, userId: String(user._id), created, ...extra });
  if (user.status === 'active')
    return result({ sent: { sms: false, email: false }, reason: 'already_active' });
  if (user.status === 'disabled')
    return result({ sent: { sms: false, email: false }, reason: 'disabled' });

  if (!created && !force) {
    const last = await AuthToken.findOne({
      orgId,
      userId: user._id,
      purpose: 'account_setup',
      usedAt: null,
    })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();
    if (last && Date.now() - last.createdAt.getTime() < RESEND_GAP_MS) {
      return result({ sent: { sms: false, email: false }, reason: 'recently_sent' });
    }
  }
  const sent = await sendAuthLink({
    org,
    user,
    purpose: 'account_setup',
    channels,
    createdBy: by?.id ?? null,
    ip: ctx?.ip ?? null,
  });
  await audit(
    ctx ?? { orgId, actor: SYSTEM_ACTOR },
    created ? 'portal.invite' : 'portal.invite_resent',
    {
      entity: { type: 'Customer', id: c._id },
      meta: {
        customerNo: c.customerNo,
        userId: String(user._id),
        sms: sent.sms,
        email: sent.email,
      },
    },
  );
  return result({ sent, ...(!sent.sms && !sent.email && { reason: 'no_channel' }) });
}

/**
 * After a booking / transfer commits: invite the holder (and co-applicants when the setting says
 * so). Never throws — a failed invite must not fail the sale; staff can resend from the
 * customer page.
 */
export async function autoInvite(org, { holderId, coApplicantIds = [], by = null }) {
  try {
    const settings = portalSettingsOf(await getAccountSettings(org._id));
    if (!settings.autoInvite) return;
    const ctx = {
      orgId: org._id,
      actor: by ? { id: by.id, name: by.name, role: by.role, kind: 'user' } : SYSTEM_ACTOR,
    };
    const ids = [holderId, ...(settings.autoInviteCoApplicants ? coApplicantIds : [])];
    for (const id of ids) await invitePortalUser({ org, customerId: id, by, ctx });
  } catch (err) {
    log.warn({ err: { message: err.message, code: err.code } }, 'portal auto-invite failed');
  }
}

/** Staff switch a login off (lost phone, dispute) or back on. */
export async function setPortalAccess({ org, customerId, enabled, ctx }) {
  const orgId = org._id;
  const c = await Customer.findOne({ orgId, _id: customerId }).lean();
  if (!c) throw new NotFoundError('Customer not found');
  if (!c.portalUserId) {
    throw new ConflictError('This customer has no portal login yet — send an invite', {
      code: 'PORTAL_NOT_INVITED',
    });
  }
  const user = await User.findOne({ orgId, _id: c.portalUserId });
  if (!user) throw new NotFoundError('Login not found');
  if (enabled) {
    if (user.status !== 'disabled') return portalStatus(orgId, c);
    // Back to where it was: invited if a password was never set.
    const withHash = await User.findOne({ orgId, _id: user._id }).select('+passwordHash').lean();
    user.status = withHash.passwordHash ? 'active' : 'invited';
  } else {
    if (user.status === 'disabled') return portalStatus(orgId, c);
    user.status = 'disabled';
  }
  user.authVersion += 1;
  await user.save();
  invalidateUser(user._id);
  if (!enabled) await revokeAllSessions({ orgId, userId: user._id, reason: 'user_disabled' });
  await audit(ctx, enabled ? 'portal.enable' : 'portal.disable', {
    entity: { type: 'Customer', id: c._id },
    meta: { customerNo: c.customerNo, userId: String(user._id) },
  });
  return portalStatus(orgId, c);
}

/**
 * The customer's name / phone / e-mail / language changed (staff edit or an approved profile
 * request) → the login follows. A phone change bumps authVersion (sign-in id changed).
 */
export async function syncPortalLogin(orgId, customer) {
  if (!customer?.portalUserId) return;
  try {
    const user = await User.findOne({ orgId, _id: customer.portalUserId });
    if (!user) return;
    const email = await freeEmail(orgId, customer.email ?? null, user._id);
    const phoneChanged = user.phone !== customer.phone;
    const emailChanged = (user.email ?? null) !== email;
    user.name = customer.name;
    user.phone = customer.phone;
    user.email = email;
    if (customer.locale) user.locale = customer.locale;
    if (phoneChanged || emailChanged) user.authVersion += 1;
    await user.save();
    invalidateUser(user._id);
  } catch (err) {
    log.warn({ err: { message: err.message } }, 'portal login sync failed');
  }
}

// ── Messages to the client ──────────────────────────────────────────────────────

export const portalUrl = (locale, path = '') =>
  `${env.CLIENT_URL.replace(/\/+$/, '')}/${locale === 'en' ? 'en' : 'bn'}/portal${path}`;

/**
 * Tell the client something (slip decided, profile request decided, online payment received).
 * SMS when `portal.resultSms` is on and the number is Bangladeshi; e-mail when there is one.
 * @param {{ bn: string, en: string }} p.sms
 * @param {{ subject: {bn,en}, lines: {bn: string[], en: string[]}, path?: string }} p.email
 */
export async function notifyClient({ org, customer, bookingId = null, sms, email }) {
  try {
    const locale = customer.locale ?? org.settings?.defaultLocale ?? 'bn';
    const lang = locale === 'en' ? 'en' : 'bn';
    const settings = portalSettingsOf(await getAccountSettings(org._id));
    if (sms && settings.resultSms && toBdMsisdn(customer.phone)) {
      await queueSms({
        orgId: org._id,
        to: customer.phone,
        text: sms[lang],
        purpose: 'portal',
        locale: lang,
        bookingId,
        customerId: customer._id,
      });
    }
    if (email && customer.email) {
      await queueEmail({
        orgId: org._id,
        to: customer.email,
        template: 'notice',
        locale: lang,
        data: {
          orgName: (lang === 'bn' && org.nameBn) || org.name,
          name: (lang === 'bn' && customer.nameBn) || customer.name,
          subject: email.subject[lang],
          lines: email.lines[lang],
          url: portalUrl(lang, email.path ?? ''),
        },
      });
    }
  } catch (err) {
    log.warn({ err: { message: err.message } }, 'client notification failed');
  }
}
