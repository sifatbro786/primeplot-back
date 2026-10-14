import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Customer cheques & PDCs (B4.2, owner decision Q1 = A):
 *
 *   received → deposited → cleared        (numbered receipt + allocation happen HERE)
 *                        ↘ bounced → deposited (re-presented) | returned
 *   received → cleared                    (cleared without a separate deposit step)
 *   received → returned                   (handed back: replaced, cancelled booking…)
 *
 * A cheque in hand is only an (unnumbered) acknowledgement, so a bounce never reverses money —
 * it adds the bounce fee to the schedule and alerts staff. Every change is a conditional
 * update on `status`, so two clicks can never clear a cheque twice.
 */
export const CHEQUE_STATUSES = Object.freeze([
  'received',
  'deposited',
  'cleared',
  'bounced',
  'returned',
]);
export const OPEN_CHEQUE_STATUSES = Object.freeze(['received', 'deposited']);

const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: CHEQUE_STATUSES, required: true },
    date: { type: Date, required: true }, // business date (00:00 Dhaka)
    at: { type: Date, required: true },
    by: { type: ObjectId, ref: 'User', default: null },
    byName: { type: String, maxlength: 120, default: null },
    note: { type: String, maxlength: 500, default: null },
  },
  { _id: false },
);

const chequeSchema = new mongoose.Schema(
  {
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    bookingNo: { type: String, required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    unitCode: { type: String, required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true, maxlength: 160 },
    soldBy: { type: ObjectId, ref: 'User', default: null },

    chequeNo: { type: String, required: true, trim: true, maxlength: 20 },
    bank: { type: String, required: true, trim: true, maxlength: 120 }, // issuing bank
    branch: { type: String, trim: true, maxlength: 120, default: null },
    chequeDate: { type: Date, required: true }, // date written on the cheque
    amount: { type: Number, required: true, min: 1 },
    receivedDate: { type: Date, required: true },

    status: { type: String, enum: CHEQUE_STATUSES, default: 'received' },
    depositBankAccountId: { type: ObjectId, ref: 'BankAccount', default: null },
    depositedDate: { type: Date, default: null },
    clearedDate: { type: Date, default: null },
    receiptId: { type: ObjectId, ref: 'Receipt', default: null },
    bouncedDate: { type: Date, default: null },
    bounceReason: { type: String, maxlength: 300, default: null },
    bounceCount: { type: Number, default: 0 },
    returnedReason: { type: String, maxlength: 300, default: null },
    history: { type: [historySchema], default: [] },
    note: { type: String, trim: true, maxlength: 500, default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'cheques' },
);

chequeSchema.plugin(baseSchema, { softDelete: false });
chequeSchema.index({ orgId: 1, bookingId: 1, status: 1 });
chequeSchema.index({ orgId: 1, status: 1, chequeDate: 1 }); // PDC register / due report
chequeSchema.index({ orgId: 1, soldBy: 1, createdAt: -1 });
chequeSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
// The same physical cheque can't be entered twice while it is still in play.
chequeSchema.index(
  { orgId: 1, bank: 1, chequeNo: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['received', 'deposited'] } } },
);

export const Cheque = mongoose.model('Cheque', chequeSchema);
