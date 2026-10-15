import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const CHANNEL_STATUSES = Object.freeze(['queued', 'skipped', 'off']);

const channelSchema = new mongoose.Schema(
  {
    status: { type: String, enum: CHANNEL_STATUSES, required: true },
    reason: { type: String, maxlength: 60, default: null }, // no_email, foreign_number, rule_off …
    smsId: { type: ObjectId, ref: 'SmsMessage', default: null },
  },
  { _id: false },
);

/**
 * Installment reminder delivery log (B5.3). One row per (booking, rule, due date): the unique
 * index makes the reminder run idempotent — a re-run, an overlapping tick or a restart can never
 * send the same reminder twice. A manual "remind now" uses ruleKey `manual` and today's date
 * as `dueDate`, so staff can send at most one per booking per day.
 */
const reminderLogSchema = new mongoose.Schema(
  {
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    bookingNo: { type: String, required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    unitCode: { type: String, required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true, maxlength: 160 },
    ruleKey: { type: String, required: true, maxlength: 30 },
    offsetDays: { type: Number, default: null },
    kind: { type: String, enum: ['upcoming', 'today', 'overdue'], required: true },
    dueDate: { type: Date, required: true }, // 00:00 Dhaka of the items' due date
    runDate: { type: String, required: true }, // 'YYYY-MM-DD' (Dhaka) it was sent
    amount: { type: Number, required: true }, // unpaid on those items, poisha
    totalOverdue: { type: Number, default: 0 },
    items: {
      type: [
        new mongoose.Schema(
          {
            itemId: { type: ObjectId, required: true },
            label: { type: String, maxlength: 160 },
            amount: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    locale: { type: String, enum: ['bn', 'en'], default: 'bn' },
    sms: { type: channelSchema, required: true },
    email: { type: channelSchema, required: true },
    by: { type: ObjectId, ref: 'User', default: null }, // manual reminders
    byName: { type: String, maxlength: 120, default: null },
  },
  { collection: 'reminder_logs' },
);

reminderLogSchema.plugin(baseSchema, { softDelete: false });
reminderLogSchema.index({ orgId: 1, bookingId: 1, ruleKey: 1, dueDate: 1 }, { unique: true });
reminderLogSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
reminderLogSchema.index({ orgId: 1, bookingId: 1, createdAt: -1 });
reminderLogSchema.index({ orgId: 1, runDate: 1 });

export const ReminderLog = mongoose.model('ReminderLog', reminderLogSchema);
