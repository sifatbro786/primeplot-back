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
    // B5.1 customer portal (owner decisions 2026-10-15)
    portal: {
      // The holder gets a client login when a booking is made / a unit is transferred to them.
      autoInvite: { type: Boolean, default: true },
      // Co-applicants are invited by staff from the customer page (not automatically).
      autoInviteCoApplicants: { type: Boolean, default: false },
      inviteSms: { type: Boolean, default: true },
      inviteEmail: { type: Boolean, default: true },
      slipUpload: { type: Boolean, default: true },
      // SSLCommerz (shown only when the store keys are set); minimum ৳1,000 unless less is due.
      onlinePayment: { type: Boolean, default: true },
      onlineMinAmount: { type: Number, min: 100, default: 100_000 },
      // SMS to the client when a slip / profile request is decided or an online payment lands.
      resultSms: { type: Boolean, default: true },
    },
    // B5.3 installment reminders. offsetDays: days from the due date (−7 = a week before).
    reminders: {
      enabled: { type: Boolean, default: true },
      sendHour: { type: Number, min: 7, max: 21, default: 10 }, // Dhaka time, not before
      rules: {
        type: [
          new mongoose.Schema(
            {
              key: { type: String, required: true, match: /^[a-z0-9_]{1,30}$/ },
              offsetDays: { type: Number, min: -60, max: 120, required: true },
              enabled: { type: Boolean, default: true },
              sms: { type: Boolean, default: true },
              email: { type: Boolean, default: true },
            },
            { _id: false },
          ),
        ],
        default: () => [
          { key: 'before_7', offsetDays: -7 },
          { key: 'due_day', offsetDays: 0 },
          { key: 'overdue_3', offsetDays: 3 },
          { key: 'overdue_15', offsetDays: 15 },
        ],
      },
    },
  },
  { collection: 'account_settings', optimisticConcurrency: true },
);

accountSettingsSchema.plugin(baseSchema, { softDelete: false });
accountSettingsSchema.path('orgId').index({ unique: true });

export const AccountSettings = mongoose.model('AccountSettings', accountSettingsSchema);
