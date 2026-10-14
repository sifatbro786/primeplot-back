import mongoose from 'mongoose';
import { AppError } from '#shared/errors/AppError.js';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/** B4.1 takes cash / bank transfer / pay order; cheque (B4.2, on clearing), online + slip (B5). */
export const RECEIPT_MODES = Object.freeze([
  'cash',
  'bank_transfer',
  'pay_order',
  'cheque',
  'online',
  'slip',
]);

const allocationSchema = new mongoose.Schema(
  {
    itemId: { type: ObjectId, required: true }, // booking.schedule[]._id
    seq: { type: Number, required: true },
    code: { type: String, required: true },
    label: { type: String, maxlength: 160 },
    amount: { type: Number, required: true }, // poisha, > 0
  },
  { _id: false },
);

/**
 * Money receipt — the customer-facing document (ARCHITECTURE §5). Written once; the only later
 * change is the reversal stamp (status + reversal fields). The money history itself is the
 * append-only `ledger_entries` collection.
 *
 * Number: <PROJECT CODE>-<FY short>-<6-digit seq>, gapless per project per fiscal year.
 */
const receiptSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, maxlength: 40 },
    seq: { type: Number, required: true },
    fyStartYear: { type: Number, required: true },

    projectId: { type: ObjectId, ref: 'Project', required: true },
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    bookingNo: { type: String, required: true },
    unitId: { type: ObjectId, ref: 'Unit', required: true },
    unitCode: { type: String, required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true, maxlength: 160 }, // as printed
    soldBy: { type: ObjectId, ref: 'User', default: null }, // booking's seller (visibility)

    date: { type: Date, required: true }, // money received (00:00 Dhaka)
    amount: { type: Number, required: true, min: 1 },
    mode: { type: String, enum: RECEIPT_MODES, required: true },
    bankAccountId: { type: ObjectId, ref: 'BankAccount', default: null },
    reference: { type: String, trim: true, maxlength: 80, default: null }, // transfer / txn ref
    instrumentNo: { type: String, trim: true, maxlength: 40, default: null }, // pay order no.
    instrumentBank: { type: String, trim: true, maxlength: 120, default: null }, // issuing bank
    instrumentDate: { type: Date, default: null },
    context: { type: String, enum: ['booking', 'payment'], default: 'payment' },
    allocations: { type: [allocationSchema], default: [] },
    note: { type: String, trim: true, maxlength: 500, default: null },

    receivedBy: { type: ObjectId, ref: 'User', default: null },
    receivedByName: { type: String, maxlength: 120, default: null },
    idempotencyKey: { type: String, maxlength: 100, default: null },

    status: { type: String, enum: ['valid', 'reversed'], default: 'valid' },
    reversal: {
      type: new mongoose.Schema(
        {
          at: { type: Date, required: true },
          by: { type: ObjectId, ref: 'User', default: null },
          byName: { type: String, maxlength: 120, default: null },
          reason: { type: String, maxlength: 500, required: true },
          entryId: { type: ObjectId, ref: 'LedgerEntry', required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { collection: 'receipts' },
);

receiptSchema.plugin(baseSchema, { softDelete: false });
receiptSchema.index({ orgId: 1, receiptNo: 1 }, { unique: true });
receiptSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
receiptSchema.index({ orgId: 1, bookingId: 1, date: 1, seq: 1 });
receiptSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
receiptSchema.index({ orgId: 1, projectId: 1, date: -1 });
receiptSchema.index({ orgId: 1, soldBy: 1, createdAt: -1 });

// Immutable except for the reversal stamp; never deleted.
const REVERSAL_PATHS = new Set(['status', 'reversal']);
const immutable = (what) =>
  new AppError(`Receipts are immutable (${what})`, { statusCode: 500, code: 'RECEIPT_IMMUTABLE' });

receiptSchema.pre(['updateOne', 'findOneAndUpdate'], function onlyReversal() {
  const u = this.getUpdate() ?? {};
  for (const [op, fields] of Object.entries(u)) {
    if (!op.startsWith('$')) throw immutable('replacement');
    if (op === '$setOnInsert') continue;
    if (op !== '$set') throw immutable(op);
    for (const k of Object.keys(fields)) {
      if (!REVERSAL_PATHS.has(k.split('.')[0]) && k !== 'updatedAt') throw immutable(k);
    }
  }
});
receiptSchema.pre(
  ['updateMany', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function blocked() {
    throw immutable(this.op);
  },
);

export const Receipt = mongoose.model('Receipt', receiptSchema);
