import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/** Logged by staff. All but `note` count as contact with the customer (first response / SLA). */
export const USER_ACTIVITY_TYPES = Object.freeze([
  'note',
  'call',
  'sms',
  'email',
  'whatsapp',
  'meeting',
  'site_visit',
]);
export const CONTACT_TYPES = Object.freeze(USER_ACTIVITY_TYPES.filter((t) => t !== 'note'));
/** Written by the system. */
export const SYSTEM_ACTIVITY_TYPES = Object.freeze([
  'created',
  'enquiry',
  'stage_change',
  'assigned',
  'merged',
  'task_created',
  'task_done',
  'updated',
  'auto_reply', // B3.2: SMS auto-reply settled — meta { smsId, status, segments, errorCode }
  'sla_escalated', // B3.2: first response overdue, managers notified — meta { dueAt, notified }
  'meta_lead', // B3.2: arrived from a Meta lead form — meta { leadgenId, formId, formName, adName, campaign }
]);
export const CALL_OUTCOMES = Object.freeze([
  'connected',
  'no_answer',
  'busy',
  'switched_off',
  'wrong_number',
  'call_back',
]);

/** Lead timeline — append-only (corrections are new entries). */
const leadActivitySchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: 'Lead', required: true },
    type: {
      type: String,
      enum: [...USER_ACTIVITY_TYPES, ...SYSTEM_ACTIVITY_TYPES],
      required: true,
    },
    body: { type: String, maxlength: 4000, default: null },
    outcome: { type: String, enum: [...CALL_OUTCOMES, null], default: null },
    durationSec: { type: Number, min: 0, max: 86_400, default: null },
    at: { type: Date, default: () => new Date() }, // when it happened (may be back-dated)
    actorId: { type: ObjectId, ref: 'User', default: null }, // null = system / website
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { collection: 'lead_activities' },
);

leadActivitySchema.plugin(baseSchema, { softDelete: false });
leadActivitySchema.index({ orgId: 1, leadId: 1, createdAt: -1, _id: -1 });

export const LeadActivity = mongoose.model('LeadActivity', leadActivitySchema);
