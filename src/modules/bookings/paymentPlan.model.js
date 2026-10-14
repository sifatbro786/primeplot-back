import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * Payment plan template (B4). `spec` is the generator input validated by zPlanSpec
 * (booking.validation.js) — see schedule.js for its shape. A booking copies the spec, so
 * editing or retiring a template never changes existing bookings.
 */
const paymentPlanSchema = new mongoose.Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', default: null }, // null = every project
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameBn: { type: String, trim: true, maxlength: 120, default: null },
    description: { type: String, trim: true, maxlength: 500, default: null },
    spec: { type: Mixed, required: true },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'payment_plans', optimisticConcurrency: true, minimize: false },
);

paymentPlanSchema.plugin(baseSchema);
paymentPlanSchema.index({ orgId: 1, projectId: 1, active: 1, sortOrder: 1 });

export const PaymentPlan = mongoose.model('PaymentPlan', paymentPlanSchema);
