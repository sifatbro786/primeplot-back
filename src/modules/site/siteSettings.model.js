import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId } = mongoose.Schema.Types;

const bilingual = (en = '', bn = '') => ({
  en: { type: String, maxlength: 400, default: en },
  bn: { type: String, maxlength: 400, default: bn },
});

export const SOCIAL_NETWORKS = Object.freeze([
  'facebook',
  'instagram',
  'youtube',
  'linkedin',
  'tiktok',
  'x',
]);

/** Site-wide SEO (B2b) — one per org. Saved changes are live (no draft). */
const siteSettingsSchema = new mongoose.Schema(
  {
    titleTemplate: bilingual('%s | {company}', '%s | {company}'),
    defaultDescription: bilingual(),
    defaultOgImageMediaId: { type: ObjectId, ref: 'Media', default: null },
    verification: {
      google: { type: String, maxlength: 100, default: '' },
      bing: { type: String, maxlength: 100, default: '' },
    },
    social: Object.fromEntries(
      SOCIAL_NETWORKS.map((n) => [n, { type: String, maxlength: 300, default: null }]),
    ),
    indexing: { type: Boolean, default: true },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'site_settings', optimisticConcurrency: true },
);

siteSettingsSchema.plugin(baseSchema, { softDelete: false });
// baseSchema already indexes orgId; make that single index unique instead of declaring a second one.
siteSettingsSchema.path('orgId').index({ unique: true });

export const SiteSettings = mongoose.model('SiteSettings', siteSettingsSchema);
