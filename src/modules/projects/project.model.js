import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { landAreaSchema } from '#shared/db/areaSchema.js';
import { LAND_UNITS } from '#shared/utils/area.js';
import { FACINGS } from '#modules/units/pricing.js';

const { ObjectId } = mongoose.Schema.Types;

export const PROJECT_KINDS = Object.freeze(['apartment', 'plot']);
export const PROJECT_STAGES = Object.freeze(['upcoming', 'ongoing', 'ready', 'completed']);
export const APPROVAL_AUTHORITIES = Object.freeze(['RAJUK', 'CDA', 'KDA', 'RDA', 'other']);

const bilingual = new mongoose.Schema(
  { en: { type: String, maxlength: 200 }, bn: { type: String, maxlength: 200 } },
  { _id: false },
);

const chargeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, maxlength: 40 },
    label: { type: String, required: true, maxlength: 120 },
    labelBn: { type: String, maxlength: 120 },
    amount: { type: Number, required: true }, // poisha
  },
  { _id: false },
);

/**
 * Rate card (all money = integer poisha). One shape for both kinds; the request schema
 * (project.validation.js) only accepts the fields of the project's kind.
 */
const pricingSchema = new mongoose.Schema(
  {
    // apartment
    ratePerSqft: Number,
    floorRise: {
      type: new mongoose.Schema({ fromFloor: Number, perFloorPerSqft: Number }, { _id: false }),
      default: undefined,
    },
    cornerPerSqft: Number,
    parkingPerSlot: Number,
    // plot
    rateUnit: { type: String, enum: LAND_UNITS },
    rate: Number,
    cornerPremiumBps: Number, // basis points of base (1000 = 10 %)
    roadWidthPremiums: {
      type: [new mongoose.Schema({ minWidthFt: Number, perUnit: Number }, { _id: false })],
      default: undefined,
    },
    // both (apartment uses perSqft, plot uses perUnit)
    facingPremiums: {
      type: [
        new mongoose.Schema(
          { facing: { type: String, enum: FACINGS }, perSqft: Number, perUnit: Number },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    charges: { type: [chargeSchema], default: undefined },
  },
  { _id: false },
);

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    nameBn: { type: String, trim: true, maxlength: 160 },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      maxlength: 80,
    },
    // Fixed at creation: units copy it and pricing strategy depends on it.
    kind: { type: String, enum: PROJECT_KINDS, required: true, immutable: true },
    stage: { type: String, enum: PROJECT_STAGES, default: 'upcoming' },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },

    tagline: { type: String, trim: true, maxlength: 200 },
    taglineBn: { type: String, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 10_000 },
    descriptionBn: { type: String, trim: true, maxlength: 10_000 },
    highlights: { type: [bilingual], default: [] },
    amenities: { type: [String], default: [] }, // keys, e.g. 'lift', 'generator', 'rooftop'

    location: {
      address: { type: String, trim: true, maxlength: 300 },
      addressBn: { type: String, trim: true, maxlength: 300 },
      area: { type: String, trim: true, maxlength: 100 }, // e.g. Bashundhara R/A
      areaBn: { type: String, trim: true, maxlength: 100 },
      city: { type: String, trim: true, maxlength: 80 },
      district: { type: String, trim: true, maxlength: 80 },
      // GeoJSON — set only when both lat & lng are known (2dsphere rejects partial points).
      geo: {
        type: new mongoose.Schema(
          {
            type: { type: String, enum: ['Point'], default: 'Point' },
            coordinates: { type: [Number] }, // [lng, lat]
          },
          { _id: false },
        ),
        default: undefined,
      },
    },

    landArea: { type: landAreaSchema, default: undefined },
    approval: {
      authority: { type: String, enum: APPROVAL_AUTHORITIES },
      number: { type: String, trim: true, maxlength: 80 },
    },
    handoverAt: { type: Date, default: null },

    coverMediaId: { type: ObjectId, ref: 'Media', default: null },
    galleryMediaIds: { type: [{ type: ObjectId, ref: 'Media' }], default: [] },
    brochureMediaId: { type: ObjectId, ref: 'Media', default: null },

    // Website shows prices only when the company wants it ("price on request" otherwise).
    publicPricing: { type: Boolean, default: false },
    pricing: { type: pricingSchema, default: () => ({}) },
    pricingUpdatedAt: { type: Date, default: null },

    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'projects', optimisticConcurrency: true, minimize: false },
);

projectSchema.plugin(baseSchema);
projectSchema.index(
  { orgId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } },
);
projectSchema.index({ orgId: 1, published: 1, featured: -1, sortOrder: 1, createdAt: -1 });
projectSchema.index({ orgId: 1, kind: 1, stage: 1 });
projectSchema.index({ 'location.geo': '2dsphere' });

export const Project = mongoose.model('Project', projectSchema);
