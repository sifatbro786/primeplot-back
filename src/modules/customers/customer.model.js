import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Buyer profile (B4). One customer can hold several bookings and be a co-applicant on others.
 * NID/passport scans and the photo are PRIVATE media (streamed only through the auth route).
 *
 * Visibility: `accessUserIds` lists the staff who may see this customer without
 * bookings:read_all — whoever created it, plus the seller of every booking it is on.
 */
const customerSchema = new mongoose.Schema(
  {
    customerNo: { type: String, required: true, maxlength: 20 }, // C-000123
    name: { type: String, required: true, trim: true, maxlength: 160 },
    nameBn: { type: String, trim: true, maxlength: 160, default: null },
    fatherName: { type: String, trim: true, maxlength: 160, default: null },
    motherName: { type: String, trim: true, maxlength: 160, default: null },
    spouseName: { type: String, trim: true, maxlength: 160, default: null },
    dateOfBirth: { type: Date, default: null },
    nationality: { type: String, trim: true, maxlength: 60, default: 'Bangladeshi' },
    nid: { type: String, trim: true, maxlength: 17, default: null },
    passportNo: { type: String, trim: true, uppercase: true, maxlength: 12, default: null },
    tin: { type: String, trim: true, maxlength: 12, default: null },

    phone: { type: String, required: true }, // E.164
    altPhone: { type: String, default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    presentAddress: { type: String, trim: true, maxlength: 500, default: null },
    permanentAddress: { type: String, trim: true, maxlength: 500, default: null },
    foreignAddress: { type: String, trim: true, maxlength: 500, default: null }, // NRB buyers
    occupation: { type: String, trim: true, maxlength: 120, default: null },
    organization: { type: String, trim: true, maxlength: 160, default: null },
    locale: { type: String, enum: ['bn', 'en'], default: null }, // SMS/e-mail language

    photoMediaId: { type: ObjectId, ref: 'Media', default: null },
    documentMediaIds: { type: [{ type: ObjectId, ref: 'Media' }], default: [] },
    leadId: { type: ObjectId, ref: 'Lead', default: null },
    notes: { type: String, trim: true, maxlength: 1000, default: null },

    accessUserIds: { type: [{ type: ObjectId, ref: 'User' }], default: [] },
    portalUserId: { type: ObjectId, ref: 'User', default: null }, // B5
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'customers', optimisticConcurrency: true },
);

customerSchema.plugin(baseSchema);
const live = { deletedAt: { $type: 'null' } };
customerSchema.index({ orgId: 1, customerNo: 1 }, { unique: true });
customerSchema.index(
  { orgId: 1, nid: 1 },
  { unique: true, partialFilterExpression: { ...live, nid: { $type: 'string' } } },
);
customerSchema.index({ orgId: 1, phone: 1 });
customerSchema.index({ orgId: 1, accessUserIds: 1, createdAt: -1 });
customerSchema.index({ orgId: 1, createdAt: -1 });

export const Customer = mongoose.model('Customer', customerSchema);
