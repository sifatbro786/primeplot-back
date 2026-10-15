import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { toBdMsisdn } from '#integrations/sms/index.js';
import { queueEmail } from '#integrations/email/queue.js';
import { queueSms } from '#modules/sms/sms.service.js';
import { issueAuthToken, TOKEN_TTL_MS } from './authToken.service.js';

/**
 * One-time links (account setup, password reset) by e-mail and/or SMS (B5). Portal clients may
 * have only a phone number, so a link can go by SMS; the SMS delivery log keeps a redacted copy.
 *
 * Returns { email: boolean, sms: boolean } — which channels were queued.
 */
const log = logger.child({ module: 'auth-links' });

const PATHS = { account_setup: 'setup-account', password_reset: 'reset-password' };

export const linkUrl = (purpose, locale, token) =>
  `${env.CLIENT_URL.replace(/\/+$/, '')}/${locale === 'en' ? 'en' : 'bn'}/${PATHS[purpose]}?token=${token}`;

const SMS_TEXT = {
  account_setup: {
    bn: ({ company, url, hours }) =>
      `${company}: আপনার কাস্টমার পোর্টাল অ্যাকাউন্ট তৈরি হয়েছে। পাসওয়ার্ড সেট করুন (${hours} ঘণ্টা মেয়াদ): ${url}`,
    en: ({ company, url, hours }) =>
      `${company}: your customer portal account is ready. Set your password (valid ${hours} h): ${url}`,
  },
  password_reset: {
    bn: ({ company, url, minutes }) =>
      `${company}: পাসওয়ার্ড রিসেট লিংক (${minutes} মিনিট মেয়াদ): ${url} — আপনি না চাইলে উপেক্ষা করুন।`,
    en: ({ company, url, minutes }) =>
      `${company}: password reset link (valid ${minutes} min): ${url} — ignore if you did not ask.`,
  },
};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnNum = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[d]);

/**
 * Issue a token for `purpose` and send the link.
 * @param {object} p
 * @param {object} p.org
 * @param {object} p.user lean/doc with _id, name, email, phone, locale
 * @param {'account_setup'|'password_reset'} p.purpose
 * @param {{ email?: boolean, sms?: boolean }} [p.channels] default: every channel the user has
 */
export async function sendAuthLink({ org, user, purpose, channels = {}, createdBy = null, ip }) {
  const wantEmail = channels.email ?? true;
  const wantSms = channels.sms ?? true;
  const canEmail = wantEmail && Boolean(user.email);
  const canSms = wantSms && Boolean(toBdMsisdn(user.phone));
  if (!canEmail && !canSms) return { email: false, sms: false };

  const { token } = await issueAuthToken({
    orgId: org._id,
    userId: user._id,
    purpose,
    createdBy,
    ip,
  });
  const locale = user.locale === 'en' ? 'en' : 'bn';
  const url = linkUrl(purpose, locale, token);
  const expiresMin = TOKEN_TTL_MS.password_reset / 60_000;
  const expiresHours = TOKEN_TTL_MS.account_setup / 3_600_000;
  const company = (locale === 'bn' && org.nameBn) || org.name;
  const sent = { email: false, sms: false };

  if (canEmail) {
    await queueEmail({
      orgId: org._id,
      to: user.email,
      template: purpose,
      locale,
      sensitive: true,
      data: { name: user.name, orgName: company, url, expiresMin, expiresHours },
    });
    sent.email = true;
  }
  if (canSms) {
    const vars = {
      company,
      url,
      hours: locale === 'bn' ? bnNum(expiresHours) : expiresHours,
      minutes: locale === 'bn' ? bnNum(expiresMin) : expiresMin,
    };
    const text = SMS_TEXT[purpose][locale](vars);
    const redacted = SMS_TEXT[purpose][locale]({ ...vars, url: '[link]' });
    try {
      await queueSms({
        orgId: org._id,
        to: user.phone,
        text,
        redacted,
        purpose,
        locale,
        customerId: user.customerId ?? null,
        // A reset link is worthless after it expires; a setup link keeps its 72 h.
        expiresInMs: purpose === 'password_reset' ? TOKEN_TTL_MS.password_reset : 24 * 3_600_000,
      });
      sent.sms = true;
    } catch (err) {
      log.warn({ err: { message: err.message, code: err.code } }, 'auth link SMS not queued');
    }
  }
  return sent;
}

/** "+8801712345678" → "+880 17••••5678" */
export function maskPhone(e164) {
  const m = /^(\+\d{3})(\d{2})\d+(\d{4})$/.exec(e164 ?? '');
  return m ? `${m[1]} ${m[2]}••••${m[3]}` : null;
}

export function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
