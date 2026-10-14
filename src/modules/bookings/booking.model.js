import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { CHARGE_KINDS, ITEM_CODES } from './schedule.js';

/** Sale stage — mirrors the unit status while the booking is active (B4.2). */
export const BOOKING_STAGES = Object.freeze(['booked', 'allotted', 'registered', 'handed_over']);

const { ObjectId, Mixed } = mongoose.Schema.Types;

const scheduleItemSchema = new mongoose.Schema({
  seq: { type: Number, required: true },
  code: { type: String, enum: ITEM_CODES, required: true },
  label: { type: String, required: true, maxlength: 160 },
  labelBn: { type: String, maxlength: 160, default: null },
  dueDate: { type: Date, default: null }, // 00:00 Dhaka; null = not called yet (milestone/handover)
  amount: { type: Number, required: true, min: 1 },
  paid: { type: Number, default: 0, min: 0 }, // cache of ledger allocations
  milestoneKey: { type: String, maxlength: 40, default: null },
  chargeKind: { type: String, enum: [...CHARGE_KINDS, null], default: null }, // code = charge
  note: { type: String, maxlength: 300, default: null },
});

const actSchema = (fields = {}) =>
  new mongoose.Schema(
    {
      date: { type: Date, required: true },
      by: { type: ObjectId, ref: 'User', default: null },
      byName: { type: String, maxlength: 120, default: null },
      note: { type: String, maxlength: 500, default: null },
      ...fields,
    },
    { _id: false },
  );

const nomineeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 160 },
    relation: { type: String, required: true, maxlength: 60 },
    phone: { type: String, default: null },
    nid: { type: String, default: null },
    sharePct: { type: Number, min: 1, max: 100, required: true },
  },
  { _id: false },
);

/**
 * Booking (B4) — the sale of one unit. Created in ONE transaction with the unit's move to
 * `booked`, the booking-money receipt and the audit entry.
 *
 * `price` freezes the unit's itemised breakdown at booking time (ARCHITECTURE §5): later rate
 * changes never touch it. `contractTotal` = list total − discount = Σ non-charge schedule items.
 */
const bookingSchema = new mongoose.Schema(
  {
    bookingNo: { type: String, required: true, maxlength: 30 }, // LVR-BK-00045
    seq: { type: Number, required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    blockId: { type: ObjectId, ref: 'Block', required: true },
    unitId: { type: ObjectId, ref: 'Unit', required: true },
    unitCode: { type: String, required: true },
    kind: { type: String, enum: ['apartment', 'plot'], required: true },

    customerId: { type: ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true, maxlength: 160 }, // at booking (search)
    coApplicantIds: { type: [{ type: ObjectId, ref: 'Customer' }], default: [] },
    nominees: { type: [nomineeSchema], default: [] },
    leadId: { type: ObjectId, ref: 'Lead', default: null },

    soldBy: { type: ObjectId, ref: 'User', required: true },
    soldByName: { type: String, maxlength: 120, default: null },
    bookingDate: { type: Date, required: true },

    price: {
      strategy: String,
      rateUnit: String,
      lines: { type: [Mixed], default: [] }, // pricing.js breakdown lines, as priced
      listTotal: { type: Number, required: true },
      baseAmount: { type: Number, required: true },
      discount: {
        amount: { type: Number, default: 0 },
        reason: { type: String, maxlength: 300, default: null },
        capBps: { type: Number, default: null }, // the user's cap at the time (null = none)
      },
      contractTotal: { type: Number, required: true },
    },
    plan: {
      planId: { type: ObjectId, ref: 'PaymentPlan', default: null },
      name: { type: String, maxlength: 120, default: null },
      spec: { type: Mixed, default: null }, // null = custom schedule
    },
    schedule: { type: [scheduleItemSchema], default: [] },
    paidTotal: { type: Number, default: 0 }, // cache: Σ schedule.paid

    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    stage: { type: String, enum: BOOKING_STAGES, default: 'booked' },
    allotment: { type: actSchema(), default: null },
    registration: {
      type: actSchema({
        deedNo: { type: String, maxlength: 60, required: true },
        subRegistryOffice: { type: String, maxlength: 120, default: null },
      }),
      default: null,
    },
    handover: { type: actSchema(), default: null },
    // Earlier holders, newest last (B4.2 transfer). The current holder is customerId/….
    holders: {
      type: [
        new mongoose.Schema({
          customerId: { type: ObjectId, ref: 'Customer', required: true },
          customerName: { type: String, maxlength: 160 },
          coApplicantIds: { type: [ObjectId], default: [] },
          nominees: { type: [nomineeSchema], default: [] },
          until: { type: Date, required: true }, // transfer date
          toCustomerId: { type: ObjectId, ref: 'Customer', required: true },
          fee: { type: Number, default: 0 },
          feeWaivedReason: { type: String, maxlength: 300, default: null },
          by: { type: ObjectId, ref: 'User', default: null },
          byName: { type: String, maxlength: 120, default: null },
          note: { type: String, maxlength: 500, default: null },
        }),
      ],
      default: [],
    },
    cancellation: {
      type: actSchema({
        reason: { type: String, maxlength: 500, required: true },
        paid: { type: Number, required: true },
        deductionBps: { type: Number, default: null },
        deduction: { type: Number, required: true },
        refundable: { type: Number, required: true },
        refunded: { type: Number, default: 0 },
        overrideReason: { type: String, maxlength: 300, default: null },
      }),
      default: null,
    },
    bookingMoneyWaived: {
      type: new mongoose.Schema(
        {
          reason: { type: String, maxlength: 300 },
          by: { type: ObjectId, ref: 'User' },
          byName: String,
        },
        { _id: false },
      ),
      default: null,
    },
    note: { type: String, trim: true, maxlength: 1000, default: null },
    idempotencyKey: { type: String, maxlength: 100, default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'bookings', optimisticConcurrency: true, minimize: false },
);

bookingSchema.plugin(baseSchema);
const live = { deletedAt: { $type: 'null' } };
bookingSchema.index({ orgId: 1, bookingNo: 1 }, { unique: true });
// Defence in depth next to the unit status machine: one active booking per unit.
bookingSchema.index(
  { orgId: 1, unitId: 1 },
  { unique: true, partialFilterExpression: { ...live, status: 'active' } },
);
bookingSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
bookingSchema.index({ orgId: 1, projectId: 1, bookingDate: -1 });
bookingSchema.index({ orgId: 1, soldBy: 1, bookingDate: -1 });
bookingSchema.index({ orgId: 1, customerId: 1 });
bookingSchema.index({ orgId: 1, coApplicantIds: 1 });
bookingSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
bookingSchema.index({ orgId: 1, status: 1, projectId: 1 }); // dues report

export const Booking = mongoose.model('Booking', bookingSchema);
