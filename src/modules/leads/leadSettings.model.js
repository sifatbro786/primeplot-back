import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * CRM settings, one document per organization (created with defaults on first read).
 * Owner decisions 2026-10-13: round-robin assignment, 30-minute first-response SLA in office
 * hours, customer auto-reply SMS on (editable, can be switched off).
 */
const leadSettingsSchema = new mongoose.Schema(
  {
    assignment: {
      mode: { type: String, enum: ['round_robin', 'manual'], default: 'round_robin' },
      // Optional per-project teams: leads for that project rotate inside the team only.
      projectPools: {
        type: [
          new mongoose.Schema(
            {
              projectId: { type: ObjectId, ref: 'Project', required: true },
              userIds: { type: [ObjectId], ref: 'User', default: [] },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
      // Round-robin cursors: "default" or a projectId → the user who got the last lead.
      cursors: { type: Map, of: ObjectId, default: () => new Map() },
    },
    sla: {
      enabled: { type: Boolean, default: true },
      firstResponseMinutes: { type: Number, min: 5, max: 1440, default: 30 },
      officeStart: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '09:00' },
      officeEnd: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '20:00' },
      // Days off, 0 = Sunday … 6 = Saturday (Bangladesh: Friday).
      weekend: { type: [Number], default: [5] },
    },
    autoReply: {
      enabled: { type: Boolean, default: true },
      textBn: {
        type: String,
        maxlength: 480,
        default:
          'ধন্যবাদ {name}! {company}-এ আপনার আগ্রহ আমরা পেয়েছি। শিগগিরই আমাদের প্রতিনিধি আপনাকে ফোন করবেন।',
      },
      textEn: {
        type: String,
        maxlength: 480,
        default:
          'Thank you {name}! {company} has received your enquiry. Our team will call you shortly.',
      },
    },
  },
  { collection: 'lead_settings', optimisticConcurrency: true },
);

leadSettingsSchema.plugin(baseSchema, { softDelete: false });
// baseSchema already indexes orgId; make that single index unique instead of declaring a second one.
leadSettingsSchema.path('orgId').index({ unique: true });

export const LeadSettings = mongoose.model('LeadSettings', leadSettingsSchema);
