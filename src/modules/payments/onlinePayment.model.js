import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 *   initiated → paid      (validated by SSLCommerz, receipt written)
 *             → review    (paid at the gateway but held: high risk / amount mismatch / overpaid /
 *                          booking no longer active) → paid (staff approve) | rejected (refund)
 *             → failed | cancelled | expired   (a later VALID validation still wins → paid)
 */
export const ONLINE_PAYMENT_STATUSES = Object.freeze([
  'initiated',
  'paid',
  'review',
  'failed',
  'cancelled',
  'expired',
  'rejected',
]);
export const OPEN_ONLINE_STATUSES = Object.freeze(['initiated', 'failed', 'cancelled', 'expired']);
export const REVIEW_REASONS = Object.freeze([
  'RISK', // SSLCommerz risk_level 1
  'AMOUNT_MISMATCH', // validated amount/currency ≠ what we asked for
  'OVERPAYMENT', // more than the booking still owes (e.g. a slip was approved meanwhile)
  'BOOKING_NOT_ACTIVE', // cancelled / transferred-away booking
  'RECEIPT_FAILED', // anything else while writing the receipt
]);
export const EVENT_SOURCES = Object.freeze([
  'init',
  'success',
  'fail',
  'cancel',
  'ipn',
  'reconcile',
  'staff',
]);

const gatewaySchema = new mongoose.Schema(
  {
    sessionKey: { type: String, default: null },
    gatewayUrl: { type: String, default: null },
    valId: { type: String, default: null },
    bankTranId: { type: String, default: null },
    cardType: { type: String, default: null },
    cardBrand: { type: String, default: null },
    cardIssuer: { type: String, default: null },
    riskLevel: { type: Number, default: null },
    riskTitle: { type: String, default: null },
    tranDate: { type: String, default: null },
    validatedAmount: { type: Number, default: null }, // poisha, as SSLCommerz reported
    validationStatus: { type: String, default: null },
    validatedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * One SSLCommerz attempt (B5.2). `tranId` is ours and unique across the database: callbacks and
 * the IPN arrive without a tenant, so they are matched by it.
 * Money becomes real ONLY through the Order Validation API (server to server); the browser
 * redirect and the IPN body are just triggers to go and check.
 */
const onlinePaymentSchema = new mongoose.Schema(
  {
    tranId: { type: String, required: true, maxlength: 30 },
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    bookingNo: { type: String, required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    unitCode: { type: String, required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true, maxlength: 160 },
    userId: { type: ObjectId, ref: 'User', required: true }, // the client who started it
    soldBy: { type: ObjectId, ref: 'User', default: null },
    locale: { type: String, enum: ['bn', 'en'], default: 'bn' },

    amount: { type: Number, required: true, min: 1 }, // poisha
    currency: { type: String, enum: ['BDT'], default: 'BDT' },
    status: { type: String, enum: ONLINE_PAYMENT_STATUSES, default: 'initiated' },
    reviewReason: { type: String, enum: [...REVIEW_REASONS, null], default: null },
    gateway: { type: gatewaySchema, default: () => ({}) },

    receiptId: { type: ObjectId, ref: 'Receipt', default: null },
    receiptNo: { type: String, default: null },
    paidAt: { type: Date, default: null },

    review: {
      type: new mongoose.Schema(
        {
          at: { type: Date, required: true },
          by: { type: ObjectId, ref: 'User', default: null },
          byName: { type: String, maxlength: 120, default: null },
          decision: { type: String, enum: ['approved', 'rejected'], required: true },
          note: { type: String, maxlength: 500, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    events: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, required: true },
            source: { type: String, enum: EVENT_SOURCES, required: true },
            status: { type: String, maxlength: 40, default: null }, // gateway status seen
            note: { type: String, maxlength: 300, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    lastCheckedAt: { type: Date, default: null },
    idempotencyKey: { type: String, maxlength: 100, default: null },
  },
  { collection: 'online_payments', minimize: false },
);

onlinePaymentSchema.plugin(baseSchema, { softDelete: false });
onlinePaymentSchema.index({ tranId: 1 }, { unique: true });
onlinePaymentSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });
onlinePaymentSchema.index({ orgId: 1, bookingId: 1, createdAt: -1 });
onlinePaymentSchema.index({ orgId: 1, customerId: 1, createdAt: -1 });
onlinePaymentSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
onlinePaymentSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const OnlinePayment = mongoose.model('OnlinePayment', onlinePaymentSchema);
