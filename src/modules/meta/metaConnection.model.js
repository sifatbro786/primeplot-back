import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * The Facebook Page connected for Lead Ads — one per organization (B3.2).
 * The Page access token is stored AES-256-GCM encrypted (`tokenEnc`, never selected by default).
 * `formMappings` route each lead form to a pipeline (buyer / landowner) and optionally a project.
 */
const formMappingSchema = new mongoose.Schema(
  {
    formId: { type: String, required: true, match: /^\d{1,30}$/ },
    formName: { type: String, maxlength: 200, default: null },
    type: { type: String, enum: ['buyer', 'landowner'], default: 'buyer' },
    projectId: { type: ObjectId, ref: 'Project', default: null },
  },
  { _id: false },
);

const metaConnectionSchema = new mongoose.Schema(
  {
    pageId: { type: String, required: true, match: /^\d{1,30}$/ },
    pageName: { type: String, maxlength: 200, default: null },
    tokenEnc: { type: String, required: true, select: false },
    tokenHint: { type: String, maxlength: 12, default: null }, // "…a1b2" — shows which token is in use
    status: { type: String, enum: ['active', 'error'], default: 'active' },
    lastError: {
      code: { type: String, default: null },
      message: { type: String, maxlength: 300, default: null },
      at: { type: Date, default: null },
    },
    formMappings: { type: [formMappingSchema], default: [] },
    connectedBy: { type: ObjectId, ref: 'User', default: null },
    connectedAt: { type: Date, default: () => new Date() },
    lastLeadAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    lastReconcile: {
      checked: { type: Number, default: 0 },
      imported: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      error: { type: String, maxlength: 300, default: null },
    },
  },
  { collection: 'meta_connections', optimisticConcurrency: true },
);

metaConnectionSchema.plugin(baseSchema, { softDelete: false });
metaConnectionSchema.path('orgId').index({ unique: true });
// A Page can feed only one organization; the webhook finds the org by page id.
metaConnectionSchema.index({ pageId: 1 }, { unique: true });

export const MetaConnection = mongoose.model('MetaConnection', metaConnectionSchema);
