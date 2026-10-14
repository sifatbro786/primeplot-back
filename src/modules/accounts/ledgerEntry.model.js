import mongoose from 'mongoose';
import { AppError } from '#shared/errors/AppError.js';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * receipt: money in (allocated). reversal: a receipt undone (negative, allocated).
 * refund: money paid back after a cancellation (negative, not allocated — B4.2).
 */
export const LEDGER_TYPES = Object.freeze(['receipt', 'reversal', 'refund']);

/**
 * The append-only money ledger per booking (ARCHITECTURE §5). Corrections are new entries,
 * never edits. `booking.schedule[].paid` is a cache of these allocations and can be rebuilt
 * from this collection (see rebuildPaid in booking.service.js).
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    receiptId: { type: ObjectId, ref: 'Receipt', default: null },
    ref: { type: String, maxlength: 40, default: null }, // receipt number
    type: { type: String, enum: LEDGER_TYPES, required: true },
    date: { type: Date, required: true }, // business date (00:00 Dhaka)
    amount: { type: Number, required: true }, // signed poisha: + in, − out/undo
    allocations: {
      type: [
        new mongoose.Schema(
          { itemId: { type: ObjectId, required: true }, amount: { type: Number, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    note: { type: String, maxlength: 500, default: null },
    by: { type: ObjectId, ref: 'User', default: null },
    byName: { type: String, maxlength: 120, default: null },
  },
  { collection: 'ledger_entries' },
);

ledgerEntrySchema.plugin(baseSchema, { softDelete: false });
ledgerEntrySchema.index({ orgId: 1, bookingId: 1, date: 1, createdAt: 1 });
ledgerEntrySchema.index({ orgId: 1, projectId: 1, date: -1 });

ledgerEntrySchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  () => {
    throw new AppError('The ledger is append-only', {
      statusCode: 500,
      code: 'LEDGER_IMMUTABLE',
    });
  },
);

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
