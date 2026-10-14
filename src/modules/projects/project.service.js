import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { offsetMeta } from '#shared/utils/pagination.js';
import { landArea } from '#shared/utils/area.js';
import { projectTags, queueRevalidate } from '#integrations/revalidate/index.js';
import { audit } from '#modules/audit/audit.service.js';
import { assertPublicMedia, publicMediaMap } from '#modules/media/media.service.js';
import * as units from '#modules/units/unit.service.js';
import * as floorplans from '#modules/floorplans/floorplan.service.js';
import { parseSeo, withMedia } from '#modules/site/site.schema.js';
// Read-only check of the number counters (no service call: accounts → projects is the import direction).
import { Counter } from '#modules/accounts/counter.model.js';
import { Project } from './project.model.js';
import { Block } from './block.model.js';

/**
 * Projects & blocks (B2). Units live in #modules/units and are reached only through its
 * service (module boundary, ARCHITECTURE §9).
 */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const staleVersion = () =>
  new ConflictError('This record was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

export function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

// ── Serialization ───────────────────────────────────────────────────────────────

const idOrNull = (v) => (v ? String(v) : null);

function locationOut(loc = {}) {
  const [lng, lat] = loc.geo?.coordinates ?? [];
  return {
    address: loc.address ?? null,
    addressBn: loc.addressBn ?? null,
    area: loc.area ?? null,
    areaBn: loc.areaBn ?? null,
    city: loc.city ?? null,
    district: loc.district ?? null,
    lat: lat ?? null,
    lng: lng ?? null,
  };
}

export function toProject(p, { media, summary } = {}) {
  return {
    id: String(p._id),
    name: p.name,
    nameBn: p.nameBn ?? null,
    slug: p.slug,
    code: p.code ?? null,
    kind: p.kind,
    stage: p.stage,
    published: p.published,
    publishedAt: p.publishedAt ?? null,
    featured: p.featured,
    sortOrder: p.sortOrder,
    tagline: p.tagline ?? null,
    taglineBn: p.taglineBn ?? null,
    description: p.description ?? null,
    descriptionBn: p.descriptionBn ?? null,
    highlights: p.highlights ?? [],
    amenities: p.amenities ?? [],
    location: locationOut(p.location),
    landArea: p.landArea ?? null,
    approval: p.approval?.authority || p.approval?.number ? p.approval : null,
    handoverAt: p.handoverAt ?? null,
    coverMediaId: idOrNull(p.coverMediaId),
    galleryMediaIds: (p.galleryMediaIds ?? []).map(String),
    brochureMediaId: idOrNull(p.brochureMediaId),
    ...(media && {
      media: {
        cover: media.get(String(p.coverMediaId)) ?? null,
        gallery: (p.galleryMediaIds ?? []).map((id) => media.get(String(id))).filter(Boolean),
        brochure: media.get(String(p.brochureMediaId)) ?? null,
      },
    }),
    publicPricing: p.publicPricing,
    pricing: p.pricing ?? {},
    pricingUpdatedAt: p.pricingUpdatedAt ?? null,
    salesPolicy: {
      cancellationDeductionBps: p.salesPolicy?.cancellationDeductionBps ?? 1000,
      transferFee: p.salesPolicy?.transferFee ?? 0,
    },
    seo: withMedia(parseSeo(p.seo), media ?? new Map()),
    ...(summary !== undefined && { inventory: summary }),
    version: p.__v ?? 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function toBlock(b) {
  return {
    id: String(b._id),
    projectId: String(b.projectId),
    kind: b.kind,
    code: b.code,
    name: b.name,
    nameBn: b.nameBn ?? null,
    lowestFloor: b.lowestFloor ?? null,
    highestFloor: b.highestFloor ?? null,
    sortOrder: b.sortOrder,
    version: b.__v ?? 0,
  };
}

// ── Lookups other modules use ────────────────────────────────────────────────────

/** Lean project or 404. */
export async function getProject(orgId, id) {
  const p = await Project.findOne({ orgId, _id: id }).lean();
  if (!p) throw new NotFoundError('Project not found');
  return p;
}

/** Cheap check used by sockets/public routes: { kind, published, slug } or null. */
export async function getProjectAccess(orgId, id) {
  const p = await Project.findOne({ orgId, _id: id }).select('kind published slug').lean();
  return p ? { kind: p.kind, published: p.published, slug: p.slug } : null;
}

export async function getPublishedProjectBySlug(orgId, slug) {
  const p = await Project.findOne({ orgId, slug, published: true }).lean();
  if (!p) throw new NotFoundError('Project not found');
  return p;
}

/** Website listing query (published only). */
export async function findPublishedProjects(
  orgId,
  { q, kind, stage, city, area, featured, page, limit },
) {
  const filter = { orgId, published: true };
  if (kind) filter.kind = kind;
  if (stage) filter.stage = stage;
  if (featured) filter.featured = featured === 'true';
  if (city) filter['location.city'] = new RegExp(`^${escapeRegex(city)}$`, 'i');
  if (area) filter['location.area'] = new RegExp(escapeRegex(area), 'i');
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { nameBn: rx }, { 'location.area': rx }, { 'location.areaBn': rx }];
  }
  const [rows, total] = await Promise.all([
    Project.find(filter)
      .sort({ featured: -1, sortOrder: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Project.countDocuments(filter),
  ]);
  return { rows, total };
}

export async function getBlock(orgId, projectId, blockId) {
  const b = await Block.findOne({ orgId, projectId, _id: blockId }).lean();
  if (!b) throw new NotFoundError('Block not found');
  return b;
}

export async function listBlocksOf(orgId, projectId) {
  return Block.find({ orgId, projectId }).sort({ sortOrder: 1, code: 1 }).lean();
}

/** Revalidate the public pages of a project if it is (or just was) on the website. */
export function revalidateProject(orgId, project, { alsoSlug } = {}) {
  if (!project?.published && !alsoSlug) return;
  const tags = projectTags(project.slug);
  if (alsoSlug && alsoSlug !== project.slug) tags.push(`project:${alsoSlug}`);
  return queueRevalidate(orgId, tags);
}

// ── Projects ────────────────────────────────────────────────────────────────────

function applyFields(doc, input, kind) {
  const simple = [
    'name',
    'nameBn',
    'slug',
    'stage',
    'featured',
    'sortOrder',
    'tagline',
    'taglineBn',
    'description',
    'descriptionBn',
    'highlights',
    'amenities',
    'coverMediaId',
    'galleryMediaIds',
    'brochureMediaId',
    'publicPricing',
  ];
  for (const k of simple) if (input[k] !== undefined) doc.set(k, input[k]);

  if (input.code !== undefined) doc.code = input.code;
  if (input.salesPolicy !== undefined) {
    for (const [k, v] of Object.entries(input.salesPolicy)) doc.set(`salesPolicy.${k}`, v);
  }
  if (input.seo !== undefined) {
    doc.seo = input.seo;
    doc.markModified('seo');
  }
  if (input.published !== undefined && input.published !== doc.published) {
    doc.published = input.published;
    if (input.published) doc.publishedAt = new Date();
  }
  if (input.handoverAt !== undefined) {
    doc.handoverAt = input.handoverAt ? new Date(`${input.handoverAt}T00:00:00+06:00`) : null;
  }
  if (input.approval !== undefined) {
    doc.approval = input.approval ?? { authority: undefined, number: undefined };
  }
  if (input.landArea !== undefined) {
    doc.landArea = input.landArea ? landArea(input.landArea.value, input.landArea.unit) : undefined;
  }
  if (input.location !== undefined) {
    const { lat, lng, ...rest } = input.location;
    for (const [k, v] of Object.entries(rest)) doc.set(`location.${k}`, v);
    if (lat !== undefined) {
      doc.set('location.geo', lat == null ? undefined : { type: 'Point', coordinates: [lng, lat] });
    }
  }
  if (kind && !doc.kind) doc.kind = kind;
}

async function checkMedia(orgId, input) {
  const images = [
    input.coverMediaId,
    ...(input.galleryMediaIds ?? []),
    input.seo?.ogImageMediaId,
  ].filter(Boolean);
  if (images.length) await assertPublicMedia(orgId, images, { kind: 'image' });
  if (input.brochureMediaId) await assertPublicMedia(orgId, [input.brochureMediaId]);
}

export async function listProjects(orgId, { q, kind, stage, published, page, limit }) {
  const filter = { orgId };
  if (kind) filter.kind = kind;
  if (stage) filter.stage = stage;
  if (published) filter.published = published === 'true';
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { nameBn: rx }, { slug: rx }, { 'location.area': rx }];
  }
  const [rows, total] = await Promise.all([
    Project.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Project.countDocuments(filter),
  ]);
  const summaries = await units.summarizeProjects(
    orgId,
    rows.map((r) => r._id),
  );
  const media = await publicMediaMap(
    orgId,
    rows.map((r) => r.coverMediaId),
  );
  return {
    items: rows.map((p) => toProject(p, { summary: summaries.get(String(p._id)) ?? null, media })),
    meta: offsetMeta({ page, limit }, total),
  };
}

export async function getProjectDetail(orgId, id) {
  const p = await getProject(orgId, id);
  const [summaries, media, blocks] = await Promise.all([
    units.summarizeProjects(orgId, [p._id]),
    publicMediaMap(orgId, [
      p.coverMediaId,
      ...(p.galleryMediaIds ?? []),
      p.brochureMediaId,
      p.seo?.ogImageMediaId,
    ]),
    listBlocksOf(orgId, p._id),
  ]);
  const codeLocked = Boolean(p.code) && (await codeIssued(orgId, p._id));
  return {
    ...toProject(p, { media, summary: summaries.get(String(p._id)) ?? null }),
    codeLocked, // B4: numbers already issued with this code (PATCH code → 409 PROJECT_CODE_LOCKED)
    blocks: blocks.map(toBlock),
  };
}

export async function createProject({ orgId, input, ctx }) {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) {
    throw new ValidationError([
      {
        path: 'slug',
        message: 'Give an English slug (the name has no Latin letters)',
        code: 'custom',
      },
    ]);
  }
  await checkMedia(orgId, input);
  const doc = new Project({ orgId, kind: input.kind, createdBy: ctx.actor.id ?? null });
  applyFields(doc, { ...input, slug });
  await doc.save();
  await audit(ctx, 'project.create', {
    entity: { type: 'Project', id: doc._id },
    meta: { name: doc.name, kind: doc.kind, slug: doc.slug },
  });
  if (doc.published) await revalidateProject(orgId, doc);
  return getProjectDetail(orgId, doc._id);
}

const AUDITED = [
  'name',
  'code',
  'salesPolicy',
  'nameBn',
  'slug',
  'stage',
  'published',
  'featured',
  'sortOrder',
  'tagline',
  'taglineBn',
  'description',
  'descriptionBn',
  'highlights',
  'amenities',
  'location',
  'landArea',
  'approval',
  'handoverAt',
  'coverMediaId',
  'galleryMediaIds',
  'brochureMediaId',
  'publicPricing',
  'seo',
];

export async function updateProject({ orgId, id, patch, ctx }) {
  const doc = await Project.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Project not found');
  if (doc.__v !== patch.version) throw staleVersion();

  const before = doc.toObject();
  await checkMedia(orgId, patch);
  const { version: _v, ...input } = patch;
  if (input.code !== undefined && doc.code && input.code !== doc.code) {
    await assertCodeChangeable(orgId, doc._id);
  }
  applyFields(doc, input);
  await doc.save();

  const diff = diffFields(before, doc.toObject(), AUDITED);
  if (diff) await audit(ctx, 'project.update', { entity: { type: 'Project', id: doc._id }, diff });
  if (before.published || doc.published) {
    await revalidateProject(orgId, doc, { alsoSlug: before.slug });
  }
  return getProjectDetail(orgId, doc._id);
}

/**
 * The project code is printed in every booking, receipt and refund number. Once any of those
 * numbers was issued it is frozen — a new code would start a second series for the same project
 * and leave printed documents pointing at a code that no longer exists.
 */
async function codeIssued(orgId, projectId) {
  const key = new RegExp(`^(booking|receipt|refund):${String(projectId)}(:|$)`);
  return Boolean(await Counter.exists({ orgId, key, seq: { $gt: 0 } }));
}

export async function assertCodeChangeable(orgId, projectId) {
  if (await codeIssued(orgId, projectId)) {
    throw new ConflictError(
      'Booking or receipt numbers were already issued with this code — it can no longer change',
      { code: 'PROJECT_CODE_LOCKED' },
    );
  }
}

/** Replace the rate card, then re-price every unsold unit of the project. */
export async function replacePricing({ orgId, id, pricing, version, ctx }) {
  const doc = await Project.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Project not found');
  if (doc.__v !== version) throw staleVersion();

  const before = doc.toObject().pricing;
  doc.pricing = pricing;
  doc.pricingUpdatedAt = new Date();
  doc.markModified('pricing');
  await doc.save();

  const repriced = await units.repriceProject(orgId, doc.toObject());
  await audit(ctx, 'project.pricing_update', {
    entity: { type: 'Project', id: doc._id },
    diff: diffFields({ pricing: before }, { pricing: doc.toObject().pricing }, ['pricing']),
    meta: { repricedUnits: repriced },
  });
  if (doc.publicPricing) await revalidateProject(orgId, doc);
  return { project: await getProjectDetail(orgId, doc._id), repricedUnits: repriced };
}

/** Soft delete with its blocks, units and floor plans. Refused while anything is held/sold. */
export async function deleteProject({ orgId, id, ctx }) {
  const doc = await Project.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Project not found');
  const busy = await units.countCommitted(orgId, { projectId: doc._id });
  if (busy > 0) {
    throw new ConflictError('Units of this project are on hold or sold', {
      code: 'PROJECT_IN_USE',
      details: { committedUnits: busy },
    });
  }
  const now = new Date();
  const actor = ctx.actor.id ?? null;
  await units.softDeleteProjectInventory(orgId, doc._id, { at: now, by: actor });
  await floorplans.softDeleteForProject(orgId, doc._id, { at: now, by: actor });
  await Block.updateMany(
    { orgId, projectId: doc._id },
    { $set: { deletedAt: now, deletedBy: actor } },
  );
  await doc.softDelete(actor);
  await audit(ctx, 'project.delete', {
    entity: { type: 'Project', id: doc._id },
    meta: { name: doc.name, slug: doc.slug },
  });
  if (doc.published) await revalidateProject(orgId, doc);
}

// ── Blocks ──────────────────────────────────────────────────────────────────────

const ALLOWED_BLOCK_KINDS = { apartment: ['building'], plot: ['block', 'sector'] };

function assertBlockKind(project, kind) {
  if (!ALLOWED_BLOCK_KINDS[project.kind].includes(kind)) {
    throw new BadRequestError(
      `A ${project.kind} project can only have: ${ALLOWED_BLOCK_KINDS[project.kind].join(', ')}`,
      { code: 'INVALID_BLOCK_KIND' },
    );
  }
}

export async function listBlocks(orgId, projectId) {
  await getProject(orgId, projectId);
  return (await listBlocksOf(orgId, projectId)).map(toBlock);
}

export async function createBlock({ orgId, projectId, input, ctx }) {
  const project = await getProject(orgId, projectId);
  assertBlockKind(project, input.kind);
  if (project.kind === 'plot' && (input.lowestFloor != null || input.highestFloor != null)) {
    throw new BadRequestError('Plot blocks have no floors', { code: 'INVALID_BLOCK_KIND' });
  }
  const [b] = await Block.create([{ orgId, projectId: project._id, ...input }]);
  await audit(ctx, 'block.create', {
    entity: { type: 'Block', id: b._id },
    meta: { projectId: String(project._id), code: b.code },
  });
  await revalidateProject(orgId, project);
  return toBlock(b);
}

export async function updateBlock({ orgId, blockId, patch, ctx }) {
  const b = await Block.findOne({ orgId, _id: blockId });
  if (!b) throw new NotFoundError('Block not found');
  if (b.__v !== patch.version) throw staleVersion();
  const project = await getProject(orgId, b.projectId);
  const { version: _v, ...input } = patch;
  if (input.kind) assertBlockKind(project, input.kind);

  const lowest = input.lowestFloor !== undefined ? input.lowestFloor : b.lowestFloor;
  const highest = input.highestFloor !== undefined ? input.highestFloor : b.highestFloor;
  if (lowest != null && highest != null && lowest > highest) {
    throw new BadRequestError('lowestFloor must be ≤ highestFloor', { code: 'INVALID_FLOORS' });
  }
  if (input.lowestFloor !== undefined || input.highestFloor !== undefined) {
    const outside = await units.countOutsideFloors(orgId, b._id, lowest, highest);
    if (outside > 0) {
      throw new ConflictError('Some units are on floors outside the new range', {
        code: 'UNITS_OUTSIDE_RANGE',
        details: { units: outside },
      });
    }
  }

  const before = b.toObject();
  b.set(input);
  await b.save();
  const diff = diffFields(before, b.toObject(), [
    'kind',
    'code',
    'name',
    'nameBn',
    'lowestFloor',
    'highestFloor',
    'sortOrder',
  ]);
  if (diff) await audit(ctx, 'block.update', { entity: { type: 'Block', id: b._id }, diff });
  await revalidateProject(orgId, project);
  return toBlock(b);
}

export async function deleteBlock({ orgId, blockId, ctx }) {
  const b = await Block.findOne({ orgId, _id: blockId });
  if (!b) throw new NotFoundError('Block not found');
  const n = await units.countInBlock(orgId, b._id);
  if (n > 0) {
    throw new ConflictError('Move or delete the units of this block first', {
      code: 'BLOCK_IN_USE',
      details: { units: n },
    });
  }
  await b.softDelete(ctx.actor.id ?? null);
  await audit(ctx, 'block.delete', {
    entity: { type: 'Block', id: b._id },
    meta: { code: b.code },
  });
  await revalidateProject(orgId, await getProjectAccess(orgId, b.projectId));
}

/** Names for CRM lists: Map id → { id, name, nameBn, slug, kind } (deleted projects included). */
export async function projectSummaries(orgId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await Project.find({ orgId, _id: { $in: unique } })
    .select('name nameBn slug kind code')
    .setOptions({ withDeleted: true })
    .lean();
  return new Map(
    rows.map((p) => [
      String(p._id),
      {
        id: String(p._id),
        name: p.name,
        nameBn: p.nameBn ?? null,
        slug: p.slug,
        kind: p.kind,
        code: p.code ?? null,
      },
    ]),
  );
}
