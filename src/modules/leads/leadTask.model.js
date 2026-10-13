import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const TASK_TYPES = Object.freeze(['call', 'visit', 'meeting', 'follow_up', 'other']);
export const TASK_STATUSES = Object.freeze(['open', 'done', 'cancelled']);

/** Follow-up tasks on a lead. The earliest open task drives `lead.nextFollowUpAt`. */
const leadTaskSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: 'Lead', required: true },
    assigneeId: { type: ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: TASK_TYPES, default: 'follow_up' },
    dueAt: { type: Date, required: true },
    remindAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
    status: { type: String, enum: TASK_STATUSES, default: 'open' },
    doneAt: { type: Date, default: null },
    doneBy: { type: ObjectId, ref: 'User', default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'lead_tasks', optimisticConcurrency: true },
);

leadTaskSchema.plugin(baseSchema);
leadTaskSchema.index({ orgId: 1, assigneeId: 1, status: 1, dueAt: 1 });
leadTaskSchema.index({ orgId: 1, leadId: 1, status: 1, dueAt: 1 });
// Reminder sweep: open, not yet reminded, reminder time passed.
leadTaskSchema.index({ orgId: 1, status: 1, remindedAt: 1, remindAt: 1 });

export const LeadTask = mongoose.model('LeadTask', leadTaskSchema);
