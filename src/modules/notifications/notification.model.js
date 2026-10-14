import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const NOTIFICATION_TYPES = Object.freeze([
  'lead.assigned', // a lead was given to you
  'lead.enquiry', // your lead enquired again (website / Facebook)
  'lead.unassigned', // a new lead nobody owns (to people who can assign)
  'task.due', // your follow-up is due
  'lead.sla_breached', // a new lead waited past its first-response time (to managers)
  'integration.error', // Meta / SMS stopped working (to admins)
  'cheque.bounced', // B4.2: a customer's cheque bounced (to the seller and cheque managers)
]);

const TTL_DAYS = 90;

/**
 * In-app notifications for staff. Stored as `type` + `data`; the dashboard renders the text in
 * the viewer's language. Kept 90 days (TTL), so Atlas M0 storage stays small.
 */
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    expireAt: { type: Date, default: () => new Date(Date.now() + TTL_DAYS * 86_400_000) },
  },
  { collection: 'notifications' },
);

notificationSchema.plugin(baseSchema, { softDelete: false });
notificationSchema.index({ orgId: 1, userId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ orgId: 1, userId: 1, readAt: 1 });
notificationSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const Notification = mongoose.model('Notification', notificationSchema);
