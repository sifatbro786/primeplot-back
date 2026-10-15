import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const SLIP_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'withdrawn']);
export const SLIP_CHANNELS = Object.freeze(['bank_transfer', 'cash_deposit', 'pay_order']);

/**
 * Bank slip uploaded by a client in the portal (D5, B5.1). Staff verify it against the bank
 * statement: approve → a normal receipt (mode `slip`, same ledger and allocation), reject →
 * the client is told why. The slip image/PDF is a PRIVATE `payment_slip` media file.
 *
 *   pending → approved (receiptId) | rejected (reason) | withdrawn (by the client)
 */
const slipSchema = new mongoose.Schema(
  {
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    bookingNo: { type: String, required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    unitCode: { type: String, required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true }, // who submitted
    customerName: { type: String, required: true, maxlength: 160 },
    soldBy: { type: ObjectId, ref: 'User', default: null }, // the seller is told too
    submittedBy: { type: ObjectId, ref: 'User', required: true },

    amount: { type: Number, required: true, min: 1 }, // poisha, as claimed
    paidOn: { type: Date, required: true }, // 00:00 Dhaka
    channel: { type: String, enum: SLIP_CHANNELS, required: true },
    bankAccountId: { type: ObjectId, ref: 'BankAccount', default: null }, // company account paid into
    reference: { type: String, trim: true, maxlength: 80, default: null },
    payerBank: { type: String, trim: true, maxlength: 120, default: null },
    mediaId: { type: ObjectId, ref: 'Media', required: true },
    mediaSha256: { type: String, default: null }, // same file uploaded twice → flagged
    note: { type: String, trim: true, maxlength: 500, default: null },

    status: { type: String, enum: SLIP_STATUSES, default: 'pending' },
    review: {
      type: new mongoose.Schema(
        {
          at: { type: Date, required: true },
          by: { type: ObjectId, ref: 'User', default: null },
          byName: { type: String, maxlength: 120, default: null },
          reason: { type: String, maxlength: 500, default: null },
          note: { type: String, maxlength: 500, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    receiptId: { type: ObjectId, ref: 'Receipt', default: null },
    receiptNo: { type: String, default: null },
  },
  { collection: 'payment_slips', optimisticConcurrency: true },
);

slipSchema.plugin(baseSchema, { softDelete: false });
slipSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });
slipSchema.index({ orgId: 1, bookingId: 1, createdAt: -1 });
slipSchema.index({ orgId: 1, customerId: 1, createdAt: -1 });
slipSchema.index({ orgId: 1, mediaSha256: 1 });
slipSchema.index(
  { orgId: 1, reference: 1 },
  { partialFilterExpression: { reference: { $type: 'string' } } },
);

export const PaymentSlip = mongoose.model('PaymentSlip', slipSchema);
