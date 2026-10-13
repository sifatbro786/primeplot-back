import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const SMS_STATUSES = Object.freeze(['queued', 'sent', 'failed', 'skipped']);
export const SMS_PURPOSES = Object.freeze(['lead_auto_reply', 'test']);

/**
 * SMS delivery log (B3.2) — one document per message, written before sending.
 *   queued → sent (handed to the provider) | failed (provider said no / gave up) |
 *   skipped (never sent: foreign number, expired before a retry, …)
 * `sent` means the gateway accepted it; handset delivery reports are not collected in v1.
 */
const smsMessageSchema = new mongoose.Schema(
  {
    to: { type: String, required: true }, // E.164
    body: { type: String, required: true, maxlength: 1600 },
    locale: { type: String, enum: ['bn', 'en', null], default: null },
    purpose: { type: String, enum: SMS_PURPOSES, required: true },
    leadId: { type: ObjectId, ref: 'Lead', default: null },

    encoding: { type: String, enum: ['gsm7', 'ucs2'], required: true },
    segments: { type: Number, min: 0, required: true },
    costPoisha: { type: Number, min: 0, default: null }, // null = price not configured

    driver: { type: String, required: true }, // log | bulksmsbd | sslwireless
    status: { type: String, enum: SMS_STATUSES, default: 'queued' },
    attempts: { type: Number, default: 0 },
    providerMessageId: { type: String, default: null },
    error: {
      code: { type: String, default: null },
      message: { type: String, maxlength: 500, default: null },
    },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    // Not worth sending after this (an auto-reply hours late reads as spam).
    expiresAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null }, // null = system
  },
  { collection: 'sms_messages' },
);

smsMessageSchema.plugin(baseSchema, { softDelete: false });
smsMessageSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
smsMessageSchema.index({ orgId: 1, leadId: 1, createdAt: -1 });
smsMessageSchema.index({ orgId: 1, to: 1, purpose: 1, createdAt: -1 }); // auto-reply once per 24 h
smsMessageSchema.index({ orgId: 1, status: 1, createdAt: -1 });

export const SmsMessage = mongoose.model('SmsMessage', smsMessageSchema);
