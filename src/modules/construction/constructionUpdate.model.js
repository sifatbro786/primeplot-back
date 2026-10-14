import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

export const MILESTONES = Object.freeze([
  'site_preparation',
  'piling',
  'foundation',
  'basement',
  'structure',
  'roof',
  'brickwork',
  'finishing',
  'handover',
]);

const bilingual = (max) => ({
  en: { type: String, maxlength: max, default: '' },
  bn: { type: String, maxlength: max, default: '' },
});

const photoSchema = new mongoose.Schema(
  { mediaId: { type: ObjectId, ref: 'Media', required: true }, caption: bilingual(200) },
  { _id: false },
);

/**
 * Construction progress post for a project (B2b): date, % complete, milestone, photos.
 * Shown on the project page (timeline) and the home page once published.
 */
const constructionUpdateSchema = new mongoose.Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true },
    blockId: { type: ObjectId, ref: 'Block', default: null },
    date: { type: Date, required: true }, // Dhaka midnight of the reported day
    title: bilingual(160),
    body: bilingual(3000),
    percent: { type: Number, min: 0, max: 100, default: null },
    milestone: { type: String, enum: [...MILESTONES, null], default: null },
    photos: { type: [photoSchema], default: [] },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'construction_updates', optimisticConcurrency: true },
);

constructionUpdateSchema.plugin(baseSchema);
constructionUpdateSchema.index({ orgId: 1, projectId: 1, date: -1, _id: -1 });
constructionUpdateSchema.index({ orgId: 1, published: 1, date: -1, _id: -1 });

export const ConstructionUpdate = mongoose.model('ConstructionUpdate', constructionUpdateSchema);
