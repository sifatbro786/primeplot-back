import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    nameBn: { type: String, trim: true, maxlength: 160 },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      maxlength: 60,
    },
    legalName: { type: String, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true }, // E.164
    address: { type: String, trim: true, maxlength: 500 },
    addressBn: { type: String, trim: true, maxlength: 500 },
    website: { type: String, trim: true, maxlength: 200 },
    tradeLicenseNo: { type: String, trim: true, maxlength: 60 },
    rehabMemberNo: { type: String, trim: true, maxlength: 60 },
    logoMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    settings: {
      defaultLocale: { type: String, enum: ['bn', 'en'], default: 'bn' },
      timezone: { type: String, default: 'Asia/Dhaka' },
      currency: { type: String, enum: ['BDT'], default: 'BDT' },
      // Bangladesh fiscal year starts in July — drives receipt numbering (B4).
      fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 7 },
    },
  },
  { collection: 'organizations' },
);

// The organization IS the tenant, so it has no orgId of its own.
organizationSchema.plugin(baseSchema, { tenant: false });
organizationSchema.index({ slug: 1 }, { unique: true });

export const Organization = mongoose.model('Organization', organizationSchema);
