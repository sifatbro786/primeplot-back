import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { landAreaSchema } from '#shared/db/areaSchema.js';
import { FACINGS } from './pricing.js';
import { BLOCK_REASONS, UNIT_STATUSES } from './unitStatus.js';

const { ObjectId } = mongoose.Schema.Types;

const holdSchema = new mongoose.Schema(
  {
    by: { type: ObjectId, ref: 'User', required: true },
    byName: { type: String, maxlength: 120 },
    at: { type: Date, required: true },
    until: { type: Date, required: true },
    note: { type: String, maxlength: 300 },
    leadId: { type: ObjectId, ref: 'Lead', default: null }, // B3
  },
  { _id: false },
);

/**
 * One model for both inventory kinds (ARCHITECTURE §3.2). `kind` is copied from the project.
 * Apartment fields and plot fields are mutually exclusive (enforced by the request schemas).
 *
 * Status is NEVER written through save(): only through the atomic transitions in
 * unit.service.js (status in the update filter). They also bump __v, so a PATCH carrying an
 * old `version` fails with STALE_VERSION instead of silently overwriting a hold.
 */
const unitSchema = new mongoose.Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true },
    blockId: { type: ObjectId, ref: 'Block', required: true },
    kind: { type: String, enum: ['apartment', 'plot'], required: true, immutable: true },
    code: { type: String, required: true, trim: true, maxlength: 40 }, // 'A-5B', 'P-12'

    // ── Apartment ──
    floor: { type: Number, default: null }, // 0 = ground, negative = basement
    position: { type: String, trim: true, maxlength: 10, default: undefined }, // 'A' on its floor
    typeLabel: { type: String, trim: true, maxlength: 60 }, // 'Type A'
    bedrooms: Number,
    bathrooms: Number,
    balconies: Number,
    saleableSqft: Number, // the sold area (super built-up) — price basis
    saleableSqm: Number, // derived
    carpetSqft: Number,
    carpetSqm: Number, // derived
    parkingSlots: { type: Number, default: 0 },

    // ── Plot ──
    plotNo: { type: String, trim: true, maxlength: 20 },
    road: { type: String, trim: true, maxlength: 60 },
    roadWidthFt: Number,
    landArea: { type: landAreaSchema, default: undefined },
    dimensions: {
      type: new mongoose.Schema(
        { frontFt: Number, backFt: Number, leftFt: Number, rightFt: Number },
        { _id: false },
      ),
      default: undefined,
    },

    // ── Both ──
    facing: { type: String, enum: FACINGS, default: null },
    isCorner: { type: Boolean, default: false },
    features: { type: [String], default: [] },
    layoutMediaId: { type: ObjectId, ref: 'Media', default: null },
    sortOrder: { type: Number, default: 0 },

    // ── Price (poisha) ──
    rateOverride: { type: Number, default: null }, // replaces the project base rate
    priceAdjustment: {
      type: new mongoose.Schema(
        { amount: Number, note: { type: String, maxlength: 200 } },
        { _id: false },
      ),
      default: undefined,
    },
    listPrice: { type: Number, default: null }, // denormalized total; null = price on request
    priceComputedAt: { type: Date, default: null },

    // ── Status ──
    status: { type: String, enum: UNIT_STATUSES, default: 'available' },
    statusChangedAt: { type: Date, default: () => new Date() },
    statusChangedBy: { type: ObjectId, ref: 'User', default: null },
    blockReason: { type: String, enum: [...BLOCK_REASONS, null], default: null },
    blockNote: { type: String, maxlength: 300, default: null },
    hold: { type: holdSchema, default: null },

    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'units', optimisticConcurrency: true },
);

unitSchema.plugin(baseSchema);

const live = { deletedAt: { $type: 'null' } };
unitSchema.index(
  { orgId: 1, projectId: 1, code: 1 },
  { unique: true, partialFilterExpression: live },
);
// Typical floor plans resolve hotspots by (block, floor, position) → must be unique.
unitSchema.index(
  { orgId: 1, blockId: 1, floor: 1, position: 1 },
  { unique: true, partialFilterExpression: { ...live, position: { $type: 'string' } } },
);
unitSchema.index({ orgId: 1, projectId: 1, status: 1 });
unitSchema.index({ orgId: 1, projectId: 1, blockId: 1, floor: -1, sortOrder: 1 });
unitSchema.index({ orgId: 1, projectId: 1, listPrice: 1 });
// Hold expiry job + per-user hold cap.
unitSchema.index({ orgId: 1, 'hold.until': 1 }, { partialFilterExpression: { status: 'held' } });
unitSchema.index({ orgId: 1, 'hold.by': 1 }, { partialFilterExpression: { status: 'held' } });

export const Unit = mongoose.model('Unit', unitSchema);
