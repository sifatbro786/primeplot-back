import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const PROFILE_REQUEST_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'withdrawn',
]);

/**
 * Fields a client may ask to change from the portal (B5.1). Name, parents, NID/passport, TIN and
 * the date of birth are on the deed papers — those change only at the office, with documents.
 */
export const PROFILE_FIELDS = Object.freeze([
  'phone',
  'altPhone',
  'email',
  'presentAddress',
  'permanentAddress',
  'foreignAddress',
  'occupation',
  'organization',
]);

/**
 * A client's request to change their contact details. Staff approve (applied to the customer,
 * audited, the login's phone/e-mail follow) or reject with a reason. One pending per customer.
 */
const profileRequestSchema = new mongoose.Schema(
  {
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true, maxlength: 160 },
    submittedBy: { type: ObjectId, ref: 'User', required: true },
    changes: { type: Mixed, required: true }, // { field: newValue } — PROFILE_FIELDS only
    before: { type: Mixed, required: true }, // the same fields as they were
    note: { type: String, trim: true, maxlength: 500, default: null },
    status: { type: String, enum: PROFILE_REQUEST_STATUSES, default: 'pending' },
    review: {
      type: new mongoose.Schema(
        {
          at: { type: Date, required: true },
          by: { type: ObjectId, ref: 'User', default: null },
          byName: { type: String, maxlength: 120, default: null },
          reason: { type: String, maxlength: 500, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { collection: 'profile_requests', minimize: false },
);

profileRequestSchema.plugin(baseSchema, { softDelete: false });
profileRequestSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });
profileRequestSchema.index({ orgId: 1, customerId: 1, createdAt: -1 });
// One open request per customer.
profileRequestSchema.index(
  { orgId: 1, customerId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
    name: 'one_pending_per_customer',
  },
);

export const ProfileRequest = mongoose.model('ProfileRequest', profileRequestSchema);
