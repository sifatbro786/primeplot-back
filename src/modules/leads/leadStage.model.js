import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { LEAD_TYPES } from './lead.model.js';

export const STAGE_KINDS = Object.freeze(['open', 'won', 'lost']);
export const STAGE_COLORS = Object.freeze([
  'neutral',
  'sage',
  'olive',
  'sand',
  'clay',
  'sky',
  'success',
  'danger',
]);

/**
 * Pipeline columns, one list per lead type (buyer / landowner). Editable by `pipeline:manage`.
 * Rules (enforced in pipeline.service): the first open stage is where new leads land; exactly
 * one `won` and at least one `lost` stage; a stage holding leads can't be removed or change kind.
 */
const leadStageSchema = new mongoose.Schema(
  {
    pipeline: { type: String, enum: LEAD_TYPES, required: true },
    key: { type: String, required: true, match: /^[a-z0-9_]{1,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    nameBn: { type: String, trim: true, maxlength: 60, default: null },
    kind: { type: String, enum: STAGE_KINDS, default: 'open' },
    order: { type: Number, required: true },
    color: { type: String, enum: STAGE_COLORS, default: 'neutral' },
  },
  { collection: 'lead_stages' },
);

leadStageSchema.plugin(baseSchema, { softDelete: false });
leadStageSchema.index({ orgId: 1, pipeline: 1, key: 1 }, { unique: true });
leadStageSchema.index({ orgId: 1, pipeline: 1, order: 1 });

export const LeadStage = mongoose.model('LeadStage', leadStageSchema);

/** Defaults created on first use (owner-approved 2026-10-13). */
export const DEFAULT_STAGES = Object.freeze({
  buyer: [
    { key: 'new', name: 'New', nameBn: 'নতুন', kind: 'open', color: 'sky' },
    {
      key: 'contacted',
      name: 'Contacted',
      nameBn: 'যোগাযোগ হয়েছে',
      kind: 'open',
      color: 'neutral',
    },
    {
      key: 'visit_scheduled',
      name: 'Site visit scheduled',
      nameBn: 'সাইট ভিজিট নির্ধারিত',
      kind: 'open',
      color: 'sand',
    },
    { key: 'visited', name: 'Visited', nameBn: 'ভিজিট হয়েছে', kind: 'open', color: 'sage' },
    { key: 'negotiation', name: 'Negotiation', nameBn: 'দরদাম', kind: 'open', color: 'olive' },
    { key: 'won', name: 'Booked', nameBn: 'বুকড', kind: 'won', color: 'success' },
    { key: 'lost', name: 'Lost', nameBn: 'বাতিল', kind: 'lost', color: 'danger' },
  ],
  landowner: [
    { key: 'new', name: 'New', nameBn: 'নতুন', kind: 'open', color: 'sky' },
    {
      key: 'contacted',
      name: 'Contacted',
      nameBn: 'যোগাযোগ হয়েছে',
      kind: 'open',
      color: 'neutral',
    },
    {
      key: 'inspection',
      name: 'Land inspection',
      nameBn: 'জমি পরিদর্শন',
      kind: 'open',
      color: 'sand',
    },
    {
      key: 'documents',
      name: 'Document check',
      nameBn: 'কাগজপত্র যাচাই',
      kind: 'open',
      color: 'sage',
    },
    { key: 'negotiation', name: 'Negotiation', nameBn: 'দরদাম', kind: 'open', color: 'olive' },
    {
      key: 'won',
      name: 'Agreement signed',
      nameBn: 'চুক্তি সম্পন্ন',
      kind: 'won',
      color: 'success',
    },
    { key: 'lost', name: 'Dropped', nameBn: 'বাদ', kind: 'lost', color: 'danger' },
  ],
});
