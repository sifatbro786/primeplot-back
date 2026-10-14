import mongoose from 'mongoose';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { projectTags, queueRevalidate } from '#integrations/revalidate/index.js';
import { audit } from '#modules/audit/audit.service.js';
import { assertPublicMedia, publicMediaMap } from '#modules/media/media.service.js';
import { Block } from '#modules/projects/block.model.js';
import { Project } from '#modules/projects/project.model.js';
import * as projects from '#modules/projects/project.service.js';
import { userNames } from '#modules/users/user.service.js';
import { SITE_TAG } from '#modules/site/site.service.js';
import { ConstructionUpdate } from './constructionUpdate.model.js';

/**
 * Construction updates (B2b) — contract: docs/API.md › B2b › Construction updates.
 * Listed newest `date` first; cursor = last row's (date, _id).
 */
const { ObjectId } = mongoose.Types;
const HOUR = 3_600_000;

const staleVersion = () =>
  new ConflictError('This update was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

const idOrNull = (v) => (v ? String(v) : null);
const dateIn = (ymd) => new Date(`${ymd}T00:00:00+06:00`);
const dateOut = (d) => new Date(d.getTime() + 6 * HOUR).toISOString().slice(0, 10);
const bi = (t) => ({ en: t?.en ?? '', bn: t?.bn ?? '' });

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.date.getTime(), String(row._id)])).toString('base64url');
}

function cursorFilter(cursor) {
  if (!cursor) return {};
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isFinite(ts) || !mongoose.isValidObjectId(id)) throw new Error('bad');
    const date = new Date(ts);
    const _id = new ObjectId(id);
    return { $or: [{ date: { $lt: date } }, { date, _id: { $lt: _id } }] };
  } catch {
    throw new BadRequestError('Invalid cursor', { code: 'INVALID_CURSOR' });
  }
}

async function page(filter, limit) {
  const rows = await ConstructionUpdate.find(filter)
    .sort({ date: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(items.at(-1)) : null };
}

async function refsFor(orgId, rows) {
  const blockIds = [...new Set(rows.map((r) => idOrNull(r.blockId)).filter(Boolean))];
  const [media, blocks, names] = await Promise.all([
    publicMediaMap(
      orgId,
      rows.flatMap((r) => r.photos.map((p) => p.mediaId)),
    ),
    blockIds.length
      ? Block.find({ orgId, _id: { $in: blockIds } })
          .select('code name nameBn')
          .lean()
      : [],
    userNames(
      orgId,
      rows.map((r) => r.createdBy),
    ),
  ]);
  return { media, blocks: new Map(blocks.map((b) => [String(b._id), b])), names };
}

function toUpdate(u, refs, { staff = true } = {}) {
  const block = u.blockId ? refs.blocks.get(String(u.blockId)) : null;
  const out = {
    id: String(u._id),
    ...(staff && { version: u.__v ?? 0, projectId: String(u.projectId) }),
    blockId: idOrNull(u.blockId),
    block: block
      ? { id: String(block._id), code: block.code, name: block.name, nameBn: block.nameBn ?? null }
      : null,
    date: dateOut(u.date),
    title: bi(u.title),
    body: bi(u.body),
    percent: u.percent ?? null,
    milestone: u.milestone ?? null,
    photos: u.photos
      .map((p) => ({
        mediaId: String(p.mediaId),
        media: refs.media.get(String(p.mediaId)) ?? null,
        caption: bi(p.caption),
      }))
      .filter((p) => staff || p.media), // a deleted photo simply disappears from the site
    ...(staff
      ? {
          published: u.published,
          publishedAt: u.publishedAt ?? null,
          createdByName: refs.names.get(idOrNull(u.createdBy)) ?? null,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        }
      : { publishedAt: u.publishedAt ?? null }),
  };
  return out;
}

async function revalidate(orgId, projectId) {
  const p = await Project.findOne({ orgId, _id: projectId }).select('slug published').lean();
  if (p?.published) await queueRevalidate(orgId, [...projectTags(p.slug), SITE_TAG]);
}

async function checkRefs(orgId, projectId, input) {
  if (input.blockId) await projects.getBlock(orgId, projectId, input.blockId);
  if (input.photos?.length) {
    await assertPublicMedia(
      orgId,
      input.photos.map((p) => p.mediaId),
      { kind: 'image' },
    );
  }
}

function apply(doc, input) {
  if (input.date !== undefined) doc.date = dateIn(input.date);
  for (const k of ['title', 'body']) if (input[k] !== undefined) doc[k] = input[k];
  for (const k of ['percent', 'milestone', 'blockId'])
    if (input[k] !== undefined) doc[k] = input[k];
  if (input.photos !== undefined) doc.photos = input.photos;
  if (input.published !== undefined && input.published !== doc.published) {
    doc.published = input.published;
    doc.publishedAt = input.published ? new Date() : null;
  }
  if (!doc.title?.en && !doc.title?.bn) {
    throw new ValidationError([{ path: 'title', message: 'Give a title', code: 'custom' }]);
  }
}

// ── Staff ───────────────────────────────────────────────────────────────────────

export async function listUpdates(orgId, projectId, { published, cursor, limit }) {
  await projects.getProject(orgId, projectId);
  const filter = { orgId, projectId, ...cursorFilter(cursor) };
  if (published) filter.published = published === 'true';
  const { items, nextCursor } = await page(filter, limit);
  const refs = await refsFor(orgId, items);
  return { items: items.map((u) => toUpdate(u, refs)), meta: { limit, nextCursor } };
}

async function getOne(orgId, id) {
  const u = await ConstructionUpdate.findOne({ orgId, _id: id }).lean();
  if (!u) throw new NotFoundError('Construction update not found');
  return toUpdate(u, await refsFor(orgId, [u]));
}

export async function createUpdate({ orgId, projectId, input, ctx }) {
  await projects.getProject(orgId, projectId);
  await checkRefs(orgId, projectId, input);
  const doc = new ConstructionUpdate({
    orgId,
    projectId,
    createdBy: ctx.actor.id ?? null,
    updatedBy: ctx.actor.id ?? null,
  });
  apply(doc, input);
  await doc.save();
  await audit(ctx, 'construction_update.create', {
    entity: { type: 'ConstructionUpdate', id: doc._id },
    meta: { projectId: String(projectId), published: doc.published },
  });
  if (doc.published) await revalidate(orgId, projectId);
  return getOne(orgId, doc._id);
}

const AUDITED = ['date', 'title', 'body', 'percent', 'milestone', 'blockId', 'photos', 'published'];

export async function updateUpdate({ orgId, id, patch, ctx }) {
  const doc = await ConstructionUpdate.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Construction update not found');
  if (doc.__v !== patch.version) throw staleVersion();
  const { version: _v, ...input } = patch;
  await checkRefs(orgId, doc.projectId, input);
  const before = doc.toObject();
  const wasPublished = doc.published;
  apply(doc, input);
  doc.updatedBy = ctx.actor.id ?? null;
  await doc.save();
  const diff = diffFields(before, doc.toObject(), AUDITED);
  if (diff) {
    await audit(ctx, 'construction_update.update', {
      entity: { type: 'ConstructionUpdate', id: doc._id },
      diff,
    });
  }
  if (wasPublished || doc.published) await revalidate(orgId, doc.projectId);
  return getOne(orgId, doc._id);
}

export async function deleteUpdate({ orgId, id, ctx }) {
  const doc = await ConstructionUpdate.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Construction update not found');
  await doc.softDelete(ctx.actor.id ?? null);
  await audit(ctx, 'construction_update.delete', {
    entity: { type: 'ConstructionUpdate', id: doc._id },
    meta: { projectId: String(doc.projectId) },
  });
  if (doc.published) await revalidate(orgId, doc.projectId);
}

// ── Public ──────────────────────────────────────────────────────────────────────

export async function listPublicUpdates(orgId, slug, { cursor, limit }) {
  const p = await projects.getPublishedProjectBySlug(orgId, slug);
  const { items, nextCursor } = await page(
    { orgId, projectId: p._id, published: true, ...cursorFilter(cursor) },
    limit,
  );
  const refs = await refsFor(orgId, items);
  return {
    items: items.map((u) => toUpdate(u, refs, { staff: false })),
    meta: { limit, nextCursor },
  };
}

/** Latest published update + count per project, for project cards and the detail page. */
export async function summariesFor(orgId, projectIds) {
  if (!projectIds.length) return new Map();
  const rows = await ConstructionUpdate.aggregate([
    {
      $match: {
        orgId: new ObjectId(String(orgId)),
        projectId: { $in: projectIds.map((id) => new ObjectId(String(id))) },
        published: true,
        deletedAt: null,
      },
    },
    { $sort: { date: -1, _id: -1 } },
    {
      $group: {
        _id: '$projectId',
        count: { $sum: 1 },
        date: { $first: '$date' },
        percent: { $first: '$percent' },
        milestone: { $first: '$milestone' },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id),
      {
        percent: r.percent ?? null,
        milestone: r.milestone ?? null,
        date: dateOut(r.date),
        count: r.count,
      },
    ]),
  );
}

/** The newest published update of each published project (home page). */
export async function latestPublic(orgId, { limit }) {
  const live = await Project.find({ orgId, published: true })
    .select('slug name nameBn stage coverMediaId')
    .lean();
  if (!live.length) return [];
  const rows = await ConstructionUpdate.aggregate([
    {
      $match: {
        orgId: new ObjectId(String(orgId)),
        projectId: { $in: live.map((p) => p._id) },
        published: true,
        deletedAt: null,
      },
    },
    { $sort: { date: -1, _id: -1 } },
    { $group: { _id: '$projectId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { date: -1, _id: -1 } },
    { $limit: limit },
  ]);
  const byId = new Map(live.map((p) => [String(p._id), p]));
  const [refs, covers] = await Promise.all([
    refsFor(orgId, rows),
    publicMediaMap(
      orgId,
      rows.map((r) => byId.get(String(r.projectId))?.coverMediaId),
    ),
  ]);
  return rows.map((u) => {
    const p = byId.get(String(u.projectId));
    return {
      ...toUpdate(u, refs, { staff: false }),
      project: {
        slug: p.slug,
        name: p.name,
        nameBn: p.nameBn ?? null,
        stage: p.stage,
        cover: covers.get(String(p.coverMediaId)) ?? null,
      },
    };
  });
}
