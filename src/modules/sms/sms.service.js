import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { enqueue } from '#jobs/scheduler.js';
import {
  analyzeSms,
  sendSms,
  smsCost,
  smsInfo,
  SmsSendError,
  toBdMsisdn,
} from '#integrations/sms/index.js';
import { BadRequestError } from '#shared/errors/AppError.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { alertIntegrationError } from '#modules/integrations/alerts.js';
import { LeadActivity } from '#modules/leads/leadActivity.model.js';
import { SmsMessage } from './smsMessage.model.js';

/**
 * SMS (B3.2): every message is logged first (delivery log), then sent by the `sms.send` job so
 * provider hiccups retry with backoff. Callers never wait for the provider.
 */
const log = logger.child({ module: 'sms' });
const { ObjectId } = mongoose.Types;

export const MAX_SEGMENTS = 8; // hard stop against a runaway template
// Setup problems: alert admins (a retry won't fix them and every next SMS will fail too).
const ALERT_CODES = new Set([
  'AUTH_FAILED',
  'SENDER_ID_INVALID',
  'INSUFFICIENT_BALANCE',
  'BALANCE_EXPIRED',
  'IP_NOT_WHITELISTED',
  'MASKING_NEEDS_BANGLA',
]);

/** Our per-message reference for providers (SSL Wireless csms_id ≤ 20 chars): ObjectId in base 36. */
export const clientRefOf = (id) => BigInt(`0x${String(id)}`).toString(36);

export function toSms(m) {
  return {
    id: String(m._id),
    to: m.to,
    body: m.sensitive ? (m.redactedBody ?? '•••') : m.body,
    locale: m.locale ?? null,
    purpose: m.purpose,
    leadId: m.leadId ? String(m.leadId) : null,
    bookingId: m.bookingId ? String(m.bookingId) : null,
    customerId: m.customerId ? String(m.customerId) : null,
    encoding: m.encoding,
    segments: m.segments,
    costPoisha: m.costPoisha ?? null,
    driver: m.driver,
    status: m.status,
    attempts: m.attempts ?? 0,
    error: m.error?.code ? { code: m.error.code, message: m.error.message ?? null } : null,
    sentAt: m.sentAt ?? null,
    failedAt: m.failedAt ?? null,
    createdAt: m.createdAt,
  };
}

/** Length/cost preview for any text (no sending). */
export function previewSms(orgId, text) {
  const info = smsInfo(orgId);
  return { ...smsCost(text, info.costPerSegmentPoisha), maxSegments: MAX_SEGMENTS };
}

/** Timeline entry on the lead once an auto-reply is settled (sent / failed / skipped). */
async function noteOnLead(orgId, msg, status, errorCode = null) {
  if (!msg.leadId || msg.purpose !== 'lead_auto_reply') return;
  try {
    await LeadActivity.create({
      orgId,
      leadId: msg.leadId,
      type: 'auto_reply',
      body: msg.body,
      meta: { smsId: String(msg._id), status, segments: msg.segments, errorCode },
    });
  } catch (err) {
    log.error({ err: { message: err.message } }, 'Failed to write auto-reply activity');
  }
}

/** Move a queued message to its final state (only once — the filter on `queued` guards it). */
async function settle(orgId, msg, status, { error, providerMessageId } = {}) {
  const now = new Date();
  const set = { status };
  if (msg.sensitive) set.body = msg.redactedBody ?? '•••'; // the secret link leaves the DB
  if (status === 'sent')
    Object.assign(set, {
      sentAt: now,
      providerMessageId: providerMessageId ?? null,
      error: { code: null, message: null },
    });
  else
    Object.assign(set, {
      failedAt: now,
      error: {
        code: error?.code ?? null,
        message: String(error?.message ?? '').slice(0, 500) || null,
      },
    });
  const res = await SmsMessage.updateOne({ orgId, _id: msg._id, status: 'queued' }, { $set: set });
  if (res.modifiedCount)
    await noteOnLead(orgId, msg, status, status === 'sent' ? null : (error?.code ?? null));
  return status;
}

/**
 * Log an SMS and queue it. Numbers outside Bangladesh are logged as `skipped` (BD gateways can't
 * reach them). Returns the message (serialized).
 * @param {object} p
 * @param {string} p.to E.164
 * @param {string} p.purpose one of SMS_PURPOSES
 * @param {number} [p.expiresInMs] give up if it can't be sent within this time
 * @param {string} [p.redacted] the same text without its secret (setup/reset links) — what the
 *   delivery log shows; the real body is wiped once the message is settled
 */
export async function queueSms({
  orgId,
  to,
  text,
  purpose,
  leadId = null,
  bookingId = null,
  customerId = null,
  locale = null,
  createdBy = null,
  expiresInMs,
  redacted,
}) {
  const info = smsInfo(orgId);
  const a = smsCost(text, info.costPerSegmentPoisha);
  if (a.segments > MAX_SEGMENTS) {
    throw new BadRequestError(`Message is ${a.segments} SMS long (max ${MAX_SEGMENTS})`, {
      code: 'SMS_TOO_LONG',
    });
  }
  const now = Date.now();
  const doc = await SmsMessage.create({
    orgId,
    to,
    body: text,
    locale,
    purpose,
    leadId,
    bookingId,
    customerId,
    sensitive: Boolean(redacted),
    redactedBody: redacted ?? null,
    encoding: a.encoding,
    segments: a.segments,
    costPoisha: a.costPoisha,
    driver: info.driver,
    expiresAt: expiresInMs ? new Date(now + expiresInMs) : null,
    createdBy,
  });
  const msg = doc.toObject();
  if (!toBdMsisdn(to)) {
    await settle(orgId, msg, 'skipped', {
      error: {
        code: 'UNSUPPORTED_DESTINATION',
        message: 'Only Bangladesh mobile numbers can receive SMS',
      },
    });
  } else {
    await enqueue({
      orgId,
      type: 'sms.send',
      payload: { messageId: String(msg._id) },
      priority: 5,
      dedupeKey: `sms:${msg._id}`,
    });
  }
  return toSms(await SmsMessage.findOne({ orgId, _id: msg._id }).lean());
}

/**
 * Job body (`sms.send`). Idempotent: a message that is no longer `queued` is left alone.
 * Retryable provider errors are rethrown (the job retries) until the last attempt, which
 * settles the message as failed.
 */
export async function deliverSms(orgId, messageId, { job, signal } = {}) {
  const msg = await SmsMessage.findOne({ orgId, _id: new ObjectId(messageId) }).lean();
  if (!msg || msg.status !== 'queued') return { status: msg?.status ?? 'missing' };
  if (msg.expiresAt && Date.now() > msg.expiresAt.getTime()) {
    return {
      status: await settle(orgId, msg, 'skipped', {
        error: { code: 'EXPIRED', message: 'Not sent in time' },
      }),
    };
  }
  await SmsMessage.updateOne({ orgId, _id: msg._id }, { $inc: { attempts: 1 } });
  try {
    const res = await sendSms(orgId, {
      to: msg.to,
      text: msg.body,
      clientRef: clientRefOf(msg._id),
      signal,
    });
    return {
      status: await settle(orgId, msg, 'sent', { providerMessageId: res.providerMessageId }),
    };
  } catch (err) {
    const known = err instanceof SmsSendError;
    const lastTry = !job || job.attempts >= job.maxAttempts;
    if (known && !err.permanent && !lastTry) {
      await SmsMessage.updateOne(
        { orgId, _id: msg._id, status: 'queued' },
        { $set: { error: { code: err.code, message: err.message.slice(0, 500) } } },
      );
      throw err; // retry with backoff
    }
    const error = known ? err : { code: 'INTERNAL', message: err?.message };
    log.warn({ smsId: messageId, code: error.code }, 'SMS not sent');
    if (known && ALERT_CODES.has(err.code))
      await alertIntegrationError(orgId, 'sms', { code: err.code, message: err.message });
    return {
      status: await settle(
        orgId,
        msg,
        error.code === 'UNSUPPORTED_DESTINATION' ? 'skipped' : 'failed',
        { error },
      ),
    };
  }
}

export async function listSmsMessages(
  orgId,
  { status, purpose, leadId, bookingId, to, cursor, limit },
) {
  const filter = { orgId, ...cursorFilter(cursor) };
  if (status) filter.status = status;
  if (purpose) filter.purpose = purpose;
  if (leadId) filter.leadId = new ObjectId(leadId);
  if (bookingId) filter.bookingId = new ObjectId(bookingId);
  if (to) filter.to = to;
  const rows = await SmsMessage.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toSms), meta };
}

/** Totals for the settings page: this month's messages and cost by status (Asia/Dhaka month). */
export async function smsSummary(orgId, now = new Date()) {
  const d = new Date(now.getTime() + 6 * 3_600_000);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 6 * 3_600_000);
  const rows = await SmsMessage.aggregate([
    { $match: { orgId: new ObjectId(String(orgId)), createdAt: { $gte: monthStart } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        segments: { $sum: '$segments' },
        costPoisha: { $sum: { $ifNull: ['$costPoisha', 0] } },
      },
    },
  ]);
  const byStatus = Object.fromEntries(
    rows.map((r) => [r._id, { count: r.count, segments: r.segments, costPoisha: r.costPoisha }]),
  );
  return { since: monthStart, byStatus };
}

export { analyzeSms };
