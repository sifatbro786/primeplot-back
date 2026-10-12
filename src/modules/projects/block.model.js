import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

export const BLOCK_KINDS = Object.freeze(['building', 'block', 'sector']);

/**
 * A building (apartment projects) or a block/sector (plot projects). Floors are not a
 * collection: a building declares its floor range and each unit carries its floor number
 * (0 = ground, negative = basement). Floor plans reference (block, floors[]).
 */
const blockSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    kind: { type: String, enum: BLOCK_KINDS, required: true },
    code: { type: String, required: true, trim: true, maxlength: 20 }, // 'A', 'Tower-2', 'Sector 3'
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameBn: { type: String, trim: true, maxlength: 120 },
    // Buildings only.
    lowestFloor: { type: Number, default: null }, // e.g. -2 = two basements
    highestFloor: { type: Number, default: null },
    sortOrder: { type: Number, default: 0 },
  },
  { collection: 'blocks', optimisticConcurrency: true },
);

blockSchema.plugin(baseSchema);
blockSchema.index(
  { orgId: 1, projectId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } },
);
blockSchema.index({ orgId: 1, projectId: 1, sortOrder: 1 });

export const Block = mongoose.model('Block', blockSchema);
