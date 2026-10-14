import { ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { queueRevalidate } from '#integrations/revalidate/index.js';
import { audit } from '#modules/audit/audit.service.js';
import { assertPublicMedia, publicMediaMap } from '#modules/media/media.service.js';
import { userNames } from '#modules/users/user.service.js';
import { DEFAULTS, defaultSections } from './site.defaults.js';
import {
  collectMediaIds,
  completeSections,
  hasContent,
  PAGE_KEYS,
  PAGES,
  parseSections,
  parseSeo,
  publicSeo,
  typeOf,
  withMedia,
  youtubeId,
} from './site.schema.js';
import { REVISIONS_KEPT, SitePage, SitePageRevision } from './sitePage.model.js';
import { SiteSettings, SOCIAL_NETWORKS } from './siteSettings.model.js';

/**
 * Website content & SEO (B2b) — contract: docs/API.md › B2b.
 * Writes are compare-and-set on `__v` (exposed as `version`); the site is revalidated through
 * the `site` tag whenever something live changes.
 */
export const SITE_TAG = 'site';

const staleVersion = () =>
  new ConflictError('This page was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

const assertPage = (key) => {
  if (!PAGE_KEYS.includes(key)) throw new NotFoundError('Unknown page', { code: 'UNKNOWN_PAGE' });
};

const idOrNull = (v) => (v ? String(v) : null);

/** Stored `{ sections, seo }` → complete, current-shape content. */
function contentOf(key, stored) {
  return {
    sections: completeSections(key, stored?.sections, DEFAULTS[key]),
    seo: parseSeo(stored?.seo),
  };
}

const defaultContent = (key) => ({ sections: defaultSections(key), seo: parseSeo() });

// Keys come out of zod in schema order, so equal content serialises identically.
const sameContent = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function checkMedia(orgId, content) {
  const ids = collectMediaIds(content);
  if (ids.length) await assertPublicMedia(orgId, ids, { kind: 'image' });
}

/** The page document, created from the defaults on first use (race-safe). */
async function loadPage(orgId, key) {
  assertPage(key);
  const found = await SitePage.findOne({ orgId, key }).lean();
  if (found) return found;
  try {
    await SitePage.create({ orgId, key, draft: defaultContent(key) });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  return SitePage.findOne({ orgId, key }).lean();
}

/** Compare-and-set on the page version; returns the updated lean document. */
async function casPage(orgId, key, version, update) {
  const doc = await SitePage.findOneAndUpdate(
    { orgId, key, __v: version },
    { ...update, $inc: { __v: 1 } },
    { returnDocument: 'after', lean: true },
  );
  if (!doc) throw staleVersion();
  return doc;
}

const withTypes = (key, sections) =>
  sections.map((s) => ({ key: s.key, type: typeOf(key, s.key), enabled: s.enabled, data: s.data }));

async function toSitePage(orgId, doc) {
  const draft = contentOf(doc.key, doc.draft);
  const live = doc.published ? contentOf(doc.key, doc.published) : null;
  const [media, names] = await Promise.all([
    publicMediaMap(orgId, collectMediaIds(draft)),
    userNames(orgId, [doc.publishedBy, doc.draftUpdatedBy]),
  ]);
  return {
    key: doc.key,
    version: doc.__v ?? 0,
    draft: {
      sections: withMedia(withTypes(doc.key, draft.sections), media),
      seo: withMedia(draft.seo, media),
    },
    hasChanges: !live || !sameContent(draft, live),
    publishedAt: doc.publishedAt ?? null,
    publishedByName: names.get(idOrNull(doc.publishedBy)) ?? null,
    draftUpdatedAt: doc.draftUpdatedAt ?? null,
    draftUpdatedByName: names.get(idOrNull(doc.draftUpdatedBy)) ?? null,
    defaults: DEFAULTS[doc.key],
  };
}

// ── Dashboard ───────────────────────────────────────────────────────────────────

export async function listPages(orgId) {
  const docs = await SitePage.find({ orgId }).lean();
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const names = await userNames(
    orgId,
    docs.flatMap((d) => [d.publishedBy, d.draftUpdatedBy]),
  );
  return PAGE_KEYS.map((key) => {
    const d = byKey.get(key);
    const draft = d ? contentOf(key, d.draft) : null;
    const live = d?.published ? contentOf(key, d.published) : null;
    return {
      key,
      sections: PAGES[key].length,
      hasChanges: !live || !sameContent(draft, live),
      publishedAt: d?.publishedAt ?? null,
      publishedByName: names.get(idOrNull(d?.publishedBy)) ?? null,
      draftUpdatedAt: d?.draftUpdatedAt ?? null,
      draftUpdatedByName: names.get(idOrNull(d?.draftUpdatedBy)) ?? null,
    };
  });
}

export async function getPage(orgId, key) {
  return toSitePage(orgId, await loadPage(orgId, key));
}

export async function saveDraft({ orgId, key, input, ctx }) {
  const page = await loadPage(orgId, key);
  if ((page.__v ?? 0) !== input.version) throw staleVersion();
  const content = {
    sections: parseSections(key, input.sections, DEFAULTS[key]),
    seo: input.seo,
  };
  await checkMedia(orgId, content);
  const doc = await casPage(orgId, key, input.version, {
    $set: { draft: content, draftUpdatedAt: new Date(), draftUpdatedBy: ctx.actor.id ?? null },
  });
  return toSitePage(orgId, doc);
}

export async function publishPage({ orgId, key, version, note, ctx }) {
  const page = await loadPage(orgId, key);
  if ((page.__v ?? 0) !== version) throw staleVersion();
  const draft = contentOf(key, page.draft);
  if (page.published && sameContent(draft, contentOf(key, page.published))) {
    throw new ConflictError('Nothing to publish — the draft is the same as the live page', {
      code: 'NO_CHANGES',
    });
  }
  await checkMedia(orgId, draft); // an image may have been deleted since it was chosen
  const now = new Date();
  const n = (page.revisionSeq ?? 0) + 1;
  const by = ctx.actor.id ?? null;
  const doc = await casPage(orgId, key, version, {
    $set: { draft, published: draft, publishedAt: now, publishedBy: by, revisionSeq: n },
  });
  await SitePageRevision.create({
    orgId,
    pageKey: key,
    n,
    content: draft,
    note: note || null,
    publishedAt: now,
    publishedBy: by,
  });
  await SitePageRevision.deleteMany({ orgId, pageKey: key, n: { $lte: n - REVISIONS_KEPT } });
  await audit(ctx, 'site.publish', {
    entity: { type: 'SitePage', id: page._id },
    meta: { page: key, revision: n, note: note || null },
  });
  await queueRevalidate(orgId, [SITE_TAG]);
  return toSitePage(orgId, doc);
}

export async function discardDraft({ orgId, key, version }) {
  const page = await loadPage(orgId, key);
  if ((page.__v ?? 0) !== version) throw staleVersion();
  const draft = page.published ? contentOf(key, page.published) : defaultContent(key);
  const doc = await casPage(orgId, key, version, {
    $set: { draft, draftUpdatedAt: page.published ? page.publishedAt : null, draftUpdatedBy: null },
  });
  return toSitePage(orgId, doc);
}

export async function listRevisions(orgId, key) {
  assertPage(key);
  const rows = await SitePageRevision.find({ orgId, pageKey: key })
    .sort({ n: -1 })
    .limit(REVISIONS_KEPT)
    .select('n note publishedAt publishedBy')
    .lean();
  const names = await userNames(
    orgId,
    rows.map((r) => r.publishedBy),
  );
  return rows.map((r) => ({
    n: r.n,
    note: r.note ?? null,
    publishedAt: r.publishedAt,
    publishedByName: names.get(idOrNull(r.publishedBy)) ?? null,
  }));
}

export async function restoreRevision({ orgId, key, n, version, ctx }) {
  const page = await loadPage(orgId, key);
  if ((page.__v ?? 0) !== version) throw staleVersion();
  const rev = await SitePageRevision.findOne({ orgId, pageKey: key, n }).lean();
  if (!rev)
    throw new NotFoundError('That version is no longer kept', { code: 'REVISION_NOT_FOUND' });
  const doc = await casPage(orgId, key, version, {
    $set: {
      draft: contentOf(key, rev.content),
      draftUpdatedAt: new Date(),
      draftUpdatedBy: ctx.actor.id ?? null,
    },
  });
  return toSitePage(orgId, doc);
}

// ── Public shape (site + preview) ───────────────────────────────────────────────

async function toPublicPage(orgId, key, content, publishedAt) {
  const visible = content.sections.filter(
    (s) => s.enabled && hasContent(s.key, typeOf(key, s.key), s.data),
  );
  const media = await publicMediaMap(orgId, collectMediaIds({ visible, seo: content.seo }));
  return {
    key,
    publishedAt: publishedAt ?? null,
    sections: visible.map((s) => {
      const type = typeOf(key, s.key);
      const data = withMedia(s.data, media);
      if (type === 'video') data.youtubeId = youtubeId(s.data.youtubeUrl);
      return { key: s.key, type, data };
    }),
    seo: publicSeo(content.seo, media),
  };
}

/** What the site shows: the live version, or the defaults until the first publish. */
export async function getPublicPage(orgId, key) {
  assertPage(key);
  const doc = await SitePage.findOne({ orgId, key }).select('published publishedAt').lean();
  const content = doc?.published ? contentOf(key, doc.published) : defaultContent(key);
  return toPublicPage(orgId, key, content, doc?.published ? doc.publishedAt : null);
}

/** The draft in the public shape (the site's preview mode). */
export async function getPreviewPage(orgId, key) {
  const page = await loadPage(orgId, key);
  return toPublicPage(orgId, key, contentOf(key, page.draft), page.publishedAt);
}

// ── Site-wide SEO settings ──────────────────────────────────────────────────────

async function loadSettings(orgId) {
  const found = await SiteSettings.findOne({ orgId }).lean();
  if (found) return found;
  try {
    return (await SiteSettings.create({ orgId })).toObject();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return SiteSettings.findOne({ orgId }).lean();
  }
}

function settingsOut(s, media) {
  return {
    titleTemplate: { en: s.titleTemplate?.en ?? '', bn: s.titleTemplate?.bn ?? '' },
    defaultDescription: {
      en: s.defaultDescription?.en ?? '',
      bn: s.defaultDescription?.bn ?? '',
    },
    defaultOgImageMediaId: idOrNull(s.defaultOgImageMediaId),
    defaultOgImage: s.defaultOgImageMediaId
      ? (media.get(String(s.defaultOgImageMediaId)) ?? null)
      : null,
    verification: { google: s.verification?.google ?? '', bing: s.verification?.bing ?? '' },
    social: Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, s.social?.[n] ?? null])),
    indexing: s.indexing !== false,
  };
}

export async function getSiteSettings(orgId) {
  const s = await loadSettings(orgId);
  const media = await publicMediaMap(orgId, [s.defaultOgImageMediaId]);
  return { version: s.__v ?? 0, ...settingsOut(s, media) };
}

export async function updateSiteSettings({ orgId, patch, ctx }) {
  const s = await loadSettings(orgId);
  if ((s.__v ?? 0) !== patch.version) throw staleVersion();
  if (patch.defaultOgImageMediaId) {
    await assertPublicMedia(orgId, [patch.defaultOgImageMediaId], { kind: 'image' });
  }
  const $set = { updatedBy: ctx.actor.id ?? null };
  for (const k of ['titleTemplate', 'defaultDescription', 'verification', 'social']) {
    if (patch[k] === undefined) continue;
    for (const [field, v] of Object.entries(patch[k])) $set[`${k}.${field}`] = v;
  }
  if (patch.defaultOgImageMediaId !== undefined)
    $set.defaultOgImageMediaId = patch.defaultOgImageMediaId;
  if (patch.indexing !== undefined) $set.indexing = patch.indexing;

  const doc = await SiteSettings.findOneAndUpdate(
    { orgId, __v: patch.version },
    { $set, $inc: { __v: 1 } },
    { returnDocument: 'after', lean: true },
  );
  if (!doc) throw staleVersion();
  const empty = new Map();
  const diff = diffFields(settingsOut(s, empty), settingsOut(doc, empty), [
    'titleTemplate',
    'defaultDescription',
    'defaultOgImageMediaId',
    'verification',
    'social',
    'indexing',
  ]);
  if (diff) {
    await audit(ctx, 'site.settings_update', {
      entity: { type: 'SiteSettings', id: doc._id },
      diff,
    });
    await queueRevalidate(orgId, [SITE_TAG]);
  }
  return getSiteSettings(orgId);
}

/** Layout metadata, schema and sitemap: settings + which pages exist and are indexable. */
export async function getPublicSite(orgId) {
  const [s, docs] = await Promise.all([
    loadSettings(orgId),
    SitePage.find({ orgId }).select('key published publishedAt').lean(),
  ]);
  const media = await publicMediaMap(orgId, [s.defaultOgImageMediaId]);
  const byKey = new Map(docs.map((d) => [d.key, d]));
  return {
    settings: settingsOut(s, media),
    pages: PAGE_KEYS.map((key) => {
      const d = byKey.get(key);
      return {
        key,
        publishedAt: d?.published ? d.publishedAt : null,
        noindex: Boolean(d?.published?.seo?.noindex),
      };
    }),
  };
}
