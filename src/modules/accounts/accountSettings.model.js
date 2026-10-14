import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

/**
 * Sales & accounts settings, one document per organization (created with defaults on first
 * read). Owner decisions 2026-10-14 (B4 scope):
 *  - discount cap per role, in basis points of the unit's base price (executive 1 %, manager
 *    3 %); people with `bookings:discount_unlimited` (admin) have no cap
 *  - booking money is taken in the same step as the booking; `bookings:override` may skip it
 *    with a reason
 *  - receipt e-mail (PDF, B4.3) on, receipt SMS off
 */
const accountSettingsSchema = new mongoose.Schema(
  {
    discountLimitBps: {
      sales_executive: { type: Number, min: 0, max: 10_000, default: 100 },
      sales_manager: { type: Number, min: 0, max: 10_000, default: 300 },
    },
    bookingMoneyRequired: { type: Boolean, default: true },
    // How far back a receipt date may go (money received earlier, entered late).
    receiptBackdateDays: { type: Number, min: 0, max: 366, default: 31 },
    // Added to the schedule as a charge when a cheque bounces (poisha; 0 = no fee). B4.2
    chequeBounceFee: { type: Number, min: 0, default: 0 },
    notify: {
      receiptEmail: { type: Boolean, default: true },
      receiptSms: { type: Boolean, default: false },
    },
  },
  { collection: 'account_settings', optimisticConcurrency: true },
);

accountSettingsSchema.plugin(baseSchema, { softDelete: false });
accountSettingsSchema.path('orgId').index({ unique: true });

export const AccountSettings = mongoose.model('AccountSettings', accountSettingsSchema);
