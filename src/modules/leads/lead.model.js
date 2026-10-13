import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { landAreaSchema } from '#shared/db/areaSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const LEAD_TYPES = Object.freeze(['buyer', 'landowner']);
export const LEAD_STATUSES = Object.freeze(['open', 'won', 'lost']);
export const LEAD_SOURCES = Object.freeze([
  'website',
  'facebook',
  'instagram',
  'manual',
  'walk_in',
  'phone',
  'referral',
  'other',
]);
export const LOST_REASONS = Object.freeze([
  'price',
  'location',
  'not_interested',
  'unreachable',
  'bought_elsewhere',
  'budget',
  'timing',
  'invalid',
  'other',
]);
export const LAND_OWNERSHIP = Object.freeze(['sole', 'joint', 'inherited', 'company', 'other']);
export const MUTATION_STATUS = Object.freeze(['done', 'pending', 'not_started', 'unknown']);

/**
 * A sales lead (B3). Buyers enquire about homes/plots; landowners offer land for a joint venture.
 *
 * Dedupe key: `openKey` = "<type>:<E.164 phone>" while the lead is open and not deleted, null
 * otherwise. A unique partial index on it makes "one open lead per phone and type" hold even
 * when two enquiries arrive at the same instant (the loser's insert fails and becomes an
 * "enquiry" on the winner).
 *
 * Optimistic concurrency: every save bumps `__v` (exposed as `version`); atomic updates bump it
 * with `$inc`. Edits and moves must send the version they loaded.
 */
const leadSchema = new mongoose.Schema(
  {
    type: { type: String, enum: LEAD_TYPES, default: 'buyer' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true }, // E.164
    altPhone: { type: String, default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },

    source: { type: String, enum: LEAD_SOURCES, required: true },
    sourceDetail: {
      page: { type: String, maxlength: 300, default: null },
      campaign: { type: String, maxlength: 200, default: null },
      medium: { type: String, maxlength: 100, default: null },
      formName: { type: String, maxlength: 200, default: null },
      referrer: { type: String, maxlength: 200, default: null }, // referral: who sent them
    },
    message: { type: String, maxlength: 2000, default: null }, // first enquiry text

    // Buyer interest
    interest: {
      projectId: { type: ObjectId, ref: 'Project', default: null },
      unitId: { type: ObjectId, ref: 'Unit', default: null },
      bedrooms: { type: Number, min: 0, max: 20, default: null },
      budgetMin: { type: Number, min: 0, default: null }, // poisha
      budgetMax: { type: Number, min: 0, default: null }, // poisha
    },

    // Landowner / joint-venture offer
    land: {
      location: { type: String, maxlength: 300, default: null },
      area: { type: landAreaSchema, default: null },
      roadWidthFt: { type: Number, min: 0, max: 500, default: null },
      ownership: { type: String, enum: [...LAND_OWNERSHIP, null], default: null },
      mutation: { type: String, enum: [...MUTATION_STATUS, null], default: null },
      expectedShare: { type: String, maxlength: 60, default: null }, // e.g. "50:50", "60% owner"
    },

    // Pipeline
    stageId: { type: ObjectId, ref: 'LeadStage', required: true },
    status: { type: String, enum: LEAD_STATUSES, default: 'open' },
    rank: { type: String, required: true }, // fractional rank inside the stage (Kanban order)
    lostReason: { type: String, enum: [...LOST_REASONS, null], default: null },
    lostNote: { type: String, maxlength: 500, default: null },
    closedAt: { type: Date, default: null },

    // Ownership & response
    assigneeId: { type: ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    slaDueAt: { type: Date, default: null }, // first response due (office hours aware)
    firstResponseAt: { type: Date, default: null },
    slaEscalatedAt: { type: Date, default: null }, // managers were told the SLA was missed (once)
    lastActivityAt: { type: Date, default: null },
    nextFollowUpAt: { type: Date, default: null }, // earliest open task

    enquiryCount: { type: Number, default: 1 },
    lastEnquiryAt: { type: Date, default: () => new Date() },
    tags: { type: [String], default: [] },

    openKey: { type: String, default: null },
    previousLeadId: { type: ObjectId, ref: 'Lead', default: null }, // closed lead, same phone
    mergedIntoId: { type: ObjectId, ref: 'Lead', default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null }, // null = website / integration
  },
  { collection: 'leads', optimisticConcurrency: true },
);

leadSchema.plugin(baseSchema);

leadSchema.index(
  { orgId: 1, openKey: 1 },
  { unique: true, partialFilterExpression: { openKey: { $type: 'string' } } },
);
leadSchema.index({ orgId: 1, phone: 1 });
leadSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
leadSchema.index({ orgId: 1, stageId: 1, rank: 1 });
leadSchema.index({ orgId: 1, assigneeId: 1, status: 1, createdAt: -1 });
leadSchema.index({ orgId: 1, status: 1, nextFollowUpAt: 1 });
leadSchema.index({ orgId: 1, status: 1, slaDueAt: 1, firstResponseAt: 1 });

export const openKeyOf = (type, phone) => `${type}:${phone}`;

export const Lead = mongoose.model('Lead', leadSchema);
