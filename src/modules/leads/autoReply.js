import { logger } from '#config/logger.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { queueSms } from '#modules/sms/sms.service.js';
import { SmsMessage } from '#modules/sms/smsMessage.model.js';
import { companyName, renderAutoReply } from './autoReplyText.js';
import { getSettings } from './pipeline.service.js';

export { localeFromPage } from './autoReplyText.js';

/**
 * Customer auto-reply SMS (owner decision 2026-10-13, B3.2 defaults):
 *  - only for a NEW lead from the website or a Meta lead form (not manual entry, not a repeat
 *    enquiry on an open lead);
 *  - at most one per phone number in 24 hours;
 *  - switched off / edited in lead settings (`autoReply`);
 *  - given up if it can't go out within 30 minutes.
 * Never throws: an SMS problem must not lose the lead.
 */
const log = logger.child({ module: 'auto-reply' });
const ONCE_PER_MS = 24 * 3_600_000;
const EXPIRES_MS = 30 * 60_000;
export async function sendAutoReply(orgId, lead, { locale } = {}) {
  try {
    const settings = await getSettings(orgId);
    if (!settings.autoReply?.enabled) return null;
    const recent = await SmsMessage.exists({
      orgId,
      to: lead.phone,
      purpose: 'lead_auto_reply',
      createdAt: { $gte: new Date(Date.now() - ONCE_PER_MS) },
    });
    if (recent) return null;

    const org = await Organization.findOne({ _id: orgId }).select('name nameBn settings').lean();
    const lang =
      locale === 'en' || locale === 'bn' ? locale : (org?.settings?.defaultLocale ?? 'bn');
    const template = lang === 'en' ? settings.autoReply.textEn : settings.autoReply.textBn;
    const text = renderAutoReply(template, { name: lead.name, company: companyName(org, lang) });
    if (!text) return null;
    return await queueSms({
      orgId,
      to: lead.phone,
      text,
      purpose: 'lead_auto_reply',
      leadId: lead._id,
      locale: lang,
      expiresInMs: EXPIRES_MS,
    });
  } catch (err) {
    log.error(
      { err: { message: err.message, code: err.code }, leadId: String(lead._id) },
      'Auto-reply not queued',
    );
    return null;
  }
}
