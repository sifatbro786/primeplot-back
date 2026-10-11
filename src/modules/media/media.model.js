import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

export const MEDIA_PURPOSES = Object.freeze([
  'general',
  'logo',
  'avatar',
  'project_image',
  'floor_plan',
  'master_plan',
  'brochure',
  'document', // NID, deed, agreement scans (private)
  'payment_slip', // client bank-transfer slip (private, D5)
]);

const variantSchema = new mongoose.Schema(
  { key: String, width: Number, height: Number, bytes: Number },
  { _id: false },
);

const mediaSchema = new mongoose.Schema(
  {
    driver: { type: String, required: true },
    visibility: { type: String, enum: ['public', 'private'], required: true },
    kind: { type: String, enum: ['image', 'document'], required: true },
    purpose: { type: String, enum: MEDIA_PURPOSES, default: 'general' },
    mime: { type: String, required: true }, // of the stored file(s), e.g. image/webp
    sourceMime: { type: String, required: true }, // detected from magic bytes on upload
    bytes: { type: Number, required: true }, // total stored bytes
    originalName: { type: String, maxlength: 200 }, // display only — never used in paths
    sha256: { type: String, required: true }, // of the uploaded bytes (duplicate detection)
    // Images: thumb/card/full WebP variants. Documents: a single `file` variant.
    variants: { type: Map, of: variantSchema, default: {} },
    width: Number,
    height: Number,
    blurDataUrl: { type: String, maxlength: 2000 },
    alt: { type: String, maxlength: 300 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'media' },
);

mediaSchema.plugin(baseSchema);
mediaSchema.index({ orgId: 1, createdAt: -1 });
mediaSchema.index({ orgId: 1, uploadedBy: 1, createdAt: -1 });
mediaSchema.index({ orgId: 1, sha256: 1 });
mediaSchema.index({ deletedAt: 1 }, { partialFilterExpression: { deletedAt: { $type: 'date' } } });

export const Media = mongoose.model('Media', mediaSchema);
