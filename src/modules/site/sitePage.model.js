import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { PAGE_KEYS } from './site.schema.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * One document per website page (B2b). `draft` is what the dashboard edits; `published` is what
 * the site shows. Both are `{ sections: [{ key, enabled, data }], seo }`, validated by
 * site.schema.js before every write (Mixed here — the schema lives in one place).
 */
const sitePageSchema = new mongoose.Schema(
  {
    key: { type: String, enum: PAGE_KEYS, required: true },
    draft: { type: Mixed, default: null },
    published: { type: Mixed, default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: ObjectId, ref: 'User', default: null },
    draftUpdatedAt: { type: Date, default: null },
    draftUpdatedBy: { type: ObjectId, ref: 'User', default: null },
    revisionSeq: { type: Number, default: 0 }, // last revision number handed out
  },
  { collection: 'site_pages', optimisticConcurrency: true, minimize: false },
);

sitePageSchema.plugin(baseSchema, { softDelete: false });
sitePageSchema.index({ orgId: 1, key: 1 }, { unique: true });

export const SitePage = mongoose.model('SitePage', sitePageSchema);

/** Published versions of a page (the last REVISIONS_KEPT are kept). */
const sitePageRevisionSchema = new mongoose.Schema(
  {
    pageKey: { type: String, enum: PAGE_KEYS, required: true },
    n: { type: Number, required: true },
    content: { type: Mixed, required: true }, // { sections, seo }
    note: { type: String, maxlength: 200, default: null },
    publishedAt: { type: Date, required: true },
    publishedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'site_page_revisions', minimize: false },
);

sitePageRevisionSchema.plugin(baseSchema, { softDelete: false });
sitePageRevisionSchema.index({ orgId: 1, pageKey: 1, n: -1 }, { unique: true });

export const SitePageRevision = mongoose.model('SitePageRevision', sitePageRevisionSchema);
export const REVISIONS_KEPT = 20;
