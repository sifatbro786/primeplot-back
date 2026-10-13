import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const META_EVENT_STATUSES = Object.freeze([
  'received', // known, not processed yet (or waiting for a retry)
  'processing',
  'imported', // a new lead was created
  'duplicate', // added as a repeat enquiry to an open lead with the same phone
  'failed', // gave up (see error) — can be retried from the dashboard
]);

/**
 * One Meta lead (leadgen id) we have seen — from the webhook or the nightly reconcile (B3.2).
 * The unique (orgId, leadgenId) index is the idempotency key: Meta retries webhooks for up to
 * 36 hours and the reconcile re-reads the last 48 hours, yet every lead is imported once.
 * No personal data is stored here — it lives on the lead.
 */
const metaLeadEventSchema = new mongoose.Schema(
  {
    leadgenId: { type: String, required: true, match: /^\d{1,30}$/ },
    pageId: { type: String, default: null },
    formId: { type: String, default: null },
    adId: { type: String, default: null },
    via: { type: String, enum: ['webhook', 'reconcile', 'retry'], required: true },
    status: { type: String, enum: META_EVENT_STATUSES, default: 'received' },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    leadId: { type: ObjectId, ref: 'Lead', default: null },
    error: {
      code: { type: String, default: null },
      message: { type: String, maxlength: 300, default: null },
      permanent: { type: Boolean, default: false },
    },
    metaCreatedAt: { type: Date, default: null }, // when the person submitted the form
    processedAt: { type: Date, default: null },
  },
  { collection: 'meta_lead_events' },
);

metaLeadEventSchema.plugin(baseSchema, { softDelete: false });
metaLeadEventSchema.index({ orgId: 1, leadgenId: 1 }, { unique: true });
metaLeadEventSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
metaLeadEventSchema.index({ orgId: 1, status: 1, createdAt: -1 });

export const MetaLeadEvent = mongoose.model('MetaLeadEvent', metaLeadEventSchema);
