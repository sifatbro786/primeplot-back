import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const FLOORPLAN_KINDS = Object.freeze(['floor', 'master']);

/**
 * Interactive plan image + polygon hotspots (ARCHITECTURE §7: coordinates normalized 0–1, so
 * the same engine draws a floor plan and a plot master plan at any size).
 *
 *  - kind 'floor'  : one building, one or more floors. A *typical* plan (same layout on floors
 *                    3–12) is drawn once: hotspots point at a unit POSITION ('A', 'B'…) and are
 *                    resolved per floor to the unit at (block, floor, position).
 *  - kind 'master' : the whole project (plot layout / site plan). Hotspots point at a unit
 *                    (plot) or a block (building / sector).
 * A hotspot with no target is a label-only area (lift, stairs, park).
 */
const hotspotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 40 }, // stable id from the editor
    label: { type: String, maxlength: 60 },
    unitId: { type: ObjectId, ref: 'Unit', default: undefined },
    position: { type: String, maxlength: 10, default: undefined },
    blockId: { type: ObjectId, ref: 'Block', default: undefined },
    points: { type: [[Number]], required: true }, // [[x, y], …] in 0–1
  },
  { _id: false },
);

const floorPlanSchema = new mongoose.Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true },
    kind: { type: String, enum: FLOORPLAN_KINDS, required: true, immutable: true },
    blockId: { type: ObjectId, ref: 'Block', default: null },
    floors: { type: [Number], default: [] },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    titleBn: { type: String, trim: true, maxlength: 120 },
    mediaId: { type: ObjectId, ref: 'Media', required: true },
    imageWidth: Number,
    imageHeight: Number,
    hotspots: { type: [hotspotSchema], default: [] },
    sortOrder: { type: Number, default: 0 },
  },
  { collection: 'floor_plans', optimisticConcurrency: true },
);

floorPlanSchema.plugin(baseSchema);
floorPlanSchema.index({ orgId: 1, projectId: 1, kind: 1, sortOrder: 1 });
floorPlanSchema.index({ orgId: 1, blockId: 1, floors: 1 });

export const FloorPlan = mongoose.model('FloorPlan', floorPlanSchema);
