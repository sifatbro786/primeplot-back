import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { zid } from '#shared/middleware/validate.js';
import { diffFields } from '#shared/utils/diff.js';
import { zText, zVersion } from '#modules/projects/project.validation.js';
import { audit } from '#modules/audit/audit.service.js';
import { assertPublicMedia, publicMediaMap } from '#modules/media/media.service.js';
import * as projects from '#modules/projects/project.service.js';
import * as units from '#modules/units/unit.service.js';
import { effectiveStatus, publicStatus } from '#modules/units/unitStatus.js';
import { FloorPlan, FLOORPLAN_KINDS } from './floorplan.model.js';

// ── Request schemas ─────────────────────────────────────────────────────────────

const coord = z.number().min(0).max(1);
const zPoints = z
  .array(z.tuple([coord, coord]))
  .min(3)
  .max(100);

export const zHotspot = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    label: zText(60).optional(),
    unitId: zid.optional(),
    position: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,10}$/)
      .optional(),
    blockId: zid.optional(),
    points: zPoints,
  })
  .strict()
  .refine(
    (h) => [h.unitId, h.position, h.blockId].filter(Boolean).length <= 1,
    'A hotspot targets at most one of unitId, position, blockId',
  );

const zHotspots = z
  .array(zHotspot)
  .max(500)
  .refine((a) => new Set(a.map((h) => h.key)).size === a.length, 'Duplicate hotspot key');

const zFloors = z
  .array(z.number().int().min(-5).max(200))
  .max(200)
  .refine((a) => new Set(a).size === a.length, 'Duplicate floor');

export const zFloorPlanCreate = z
  .object({
    kind: z.enum(FLOORPLAN_KINDS),
    blockId: zid.nullable().optional(),
    floors: zFloors.optional(),
    title: zText(120).min(1),
    titleBn: zText(120).nullable().optional(),
    mediaId: zid,
    hotspots: zHotspots.optional(),
    sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
  })
  .strict();

export const zFloorPlanPatch = z
  .object({
    blockId: zid.nullable().optional(),
    floors: zFloors.optional(),
    title: zText(120).min(1).optional(),
    titleBn: zText(120).nullable().optional(),
    mediaId: zid.optional(),
    hotspots: zHotspots.optional(),
    sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
    version: zVersion,
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

// ── Helpers ─────────────────────────────────────────────────────────────────────

const round5 = (n) => Math.round(n * 1e5) / 1e5;

const staleVersion = () =>
  new ConflictError('This record was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

function toFloorPlan(fp, media) {
  return {
    id: String(fp._id),
    projectId: String(fp.projectId),
    kind: fp.kind,
    blockId: fp.blockId ? String(fp.blockId) : null,
    floors: fp.floors ?? [],
    title: fp.title,
    titleBn: fp.titleBn ?? null,
    mediaId: String(fp.mediaId),
    image: media?.get(String(fp.mediaId)) ?? null,
    imageWidth: fp.imageWidth ?? null,
    imageHeight: fp.imageHeight ?? null,
    hotspotCount: fp.hotspots?.length ?? 0,
    sortOrder: fp.sortOrder ?? 0,
    version: fp.__v ?? 0,
    updatedAt: fp.updatedAt,
  };
}

const hotspotOut = (h) => ({
  key: h.key,
  label: h.label ?? null,
  unitId: h.unitId ? String(h.unitId) : null,
  position: h.position ?? null,
  blockId: h.blockId ? String(h.blockId) : null,
  points: h.points,
});

/** Validate shape against the plan kind, the block's floors and the project's units/blocks. */
async function normalizePlan(orgId, project, plan) {
  const blocks = await projects.listBlocksOf(orgId, project._id);
  const blockById = new Map(blocks.map((b) => [String(b._id), b]));
  const hotspots = plan.hotspots ?? [];

  if (plan.kind === 'floor') {
    const block = plan.blockId && blockById.get(String(plan.blockId));
    if (!block)
      throw new BadRequestError('A floor plan needs a building of this project', {
        code: 'INVALID_PLAN',
      });
    if (project.kind !== 'apartment') {
      throw new BadRequestError('Floor plans are for apartment projects; use a master plan', {
        code: 'INVALID_PLAN',
      });
    }
    if (!plan.floors?.length)
      throw new BadRequestError('Give at least one floor', { code: 'INVALID_PLAN' });
    const outside = plan.floors.filter(
      (f) =>
        (block.lowestFloor != null && f < block.lowestFloor) ||
        (block.highestFloor != null && f > block.highestFloor),
    );
    if (outside.length) {
      throw new BadRequestError(`Floors outside building ${block.code}: ${outside.join(', ')}`, {
        code: 'FLOOR_OUT_OF_RANGE',
      });
    }
    if (hotspots.some((h) => h.blockId)) {
      throw new BadRequestError('Floor plan hotspots point at a unit or a position', {
        code: 'INVALID_PLAN',
      });
    }
  } else {
    if (plan.floors?.length)
      throw new BadRequestError('A master plan has no floors', { code: 'INVALID_PLAN' });
    if (hotspots.some((h) => h.position)) {
      throw new BadRequestError('Master plan hotspots point at a unit or a block', {
        code: 'INVALID_PLAN',
      });
    }
    if (plan.blockId && !blockById.has(String(plan.blockId))) {
      throw new NotFoundError('Block not found');
    }
  }

  const badBlocks = hotspots.filter((h) => h.blockId && !blockById.has(String(h.blockId)));
  if (badBlocks.length) {
    throw new BadRequestError('Some hotspots point at blocks of another project', {
      code: 'INVALID_HOTSPOT_TARGET',
      details: badBlocks.map((h) => ({ path: h.key, message: 'block' })),
    });
  }
  const unitIds = [...new Set(hotspots.filter((h) => h.unitId).map((h) => String(h.unitId)))];
  const found = await units.findUnitsByIds(orgId, project._id, unitIds);
  const foundSet = new Set(found.map((u) => String(u._id)));
  const badUnits = hotspots.filter((h) => h.unitId && !foundSet.has(String(h.unitId)));
  if (badUnits.length) {
    throw new BadRequestError('Some hotspots point at units of another project', {
      code: 'INVALID_HOTSPOT_TARGET',
      details: badUnits.map((h) => ({ path: h.key, message: 'unit' })),
    });
  }

  return hotspots.map((h) => ({
    ...h,
    points: h.points.map(([x, y]) => [round5(x), round5(y)]),
  }));
}

async function loadPlan(orgId, id) {
  const fp = await FloorPlan.findOne({ orgId, _id: id }).lean();
  if (!fp) throw new NotFoundError('Floor plan not found');
  return fp;
}

// ── CRUD ────────────────────────────────────────────────────────────────────────

export async function listFloorPlans(orgId, projectId, { publicOnly = false } = {}) {
  const project = publicOnly ? null : await projects.getProject(orgId, projectId);
  const rows = await FloorPlan.find({ orgId, projectId: project?._id ?? projectId })
    .sort({ kind: -1, sortOrder: 1, createdAt: 1 })
    .lean();
  const media = await publicMediaMap(
    orgId,
    rows.map((r) => r.mediaId),
  );
  return rows.map((r) => toFloorPlan(r, media));
}

export async function createFloorPlan({ orgId, projectId, input, ctx }) {
  const project = await projects.getProject(orgId, projectId);
  const mediaMap = await assertPublicMedia(orgId, [input.mediaId], { kind: 'image' });
  const img = mediaMap.get(String(input.mediaId));
  const hotspots = await normalizePlan(orgId, project, input);
  const [fp] = await FloorPlan.create([
    {
      orgId,
      projectId: project._id,
      kind: input.kind,
      blockId: input.blockId ?? null,
      floors: input.kind === 'floor' ? [...input.floors].sort((a, b) => a - b) : [],
      title: input.title,
      titleBn: input.titleBn ?? undefined,
      mediaId: input.mediaId,
      imageWidth: img.width,
      imageHeight: img.height,
      hotspots,
      sortOrder: input.sortOrder ?? 0,
    },
  ]);
  await audit(ctx, 'floorplan.create', {
    entity: { type: 'FloorPlan', id: fp._id },
    meta: { projectId: String(project._id), kind: fp.kind, hotspots: hotspots.length },
  });
  await projects.revalidateProject(orgId, project);
  return getFloorPlan(orgId, fp._id, {});
}

export async function updateFloorPlan({ orgId, id, patch, ctx }) {
  const doc = await FloorPlan.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Floor plan not found');
  if (doc.__v !== patch.version) throw staleVersion();
  const project = await projects.getProject(orgId, doc.projectId);
  const before = doc.toObject();

  const next = {
    kind: doc.kind,
    blockId: patch.blockId !== undefined ? patch.blockId : doc.blockId,
    floors: patch.floors ?? doc.floors,
    hotspots: patch.hotspots ?? doc.toObject().hotspots,
  };
  const hotspots = await normalizePlan(orgId, project, next);
  if (patch.mediaId) {
    const img = (await assertPublicMedia(orgId, [patch.mediaId], { kind: 'image' })).get(
      String(patch.mediaId),
    );
    doc.mediaId = patch.mediaId;
    doc.imageWidth = img.width;
    doc.imageHeight = img.height;
  }
  if (patch.blockId !== undefined) doc.blockId = patch.blockId;
  if (patch.floors) doc.floors = [...patch.floors].sort((a, b) => a - b);
  if (patch.hotspots) doc.hotspots = hotspots;
  if (patch.title !== undefined) doc.title = patch.title;
  if (patch.titleBn !== undefined) doc.titleBn = patch.titleBn ?? undefined;
  if (patch.sortOrder !== undefined) doc.sortOrder = patch.sortOrder;
  await doc.save();

  const diff = diffFields(before, doc.toObject(), [
    'blockId',
    'floors',
    'title',
    'titleBn',
    'mediaId',
    'sortOrder',
  ]);
  const hotspotsChanged = patch.hotspots !== undefined;
  if (diff || hotspotsChanged) {
    await audit(ctx, 'floorplan.update', {
      entity: { type: 'FloorPlan', id: doc._id },
      diff,
      ...(hotspotsChanged && { meta: { hotspots: doc.hotspots.length } }),
    });
  }
  await projects.revalidateProject(orgId, project);
  return getFloorPlan(orgId, doc._id, {});
}

export async function deleteFloorPlan({ orgId, id, ctx }) {
  const doc = await FloorPlan.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Floor plan not found');
  await doc.softDelete(ctx.actor.id ?? null);
  await audit(ctx, 'floorplan.delete', {
    entity: { type: 'FloorPlan', id: doc._id },
    meta: { title: doc.title },
  });
  await projects.revalidateProject(orgId, await projects.getProjectAccess(orgId, doc.projectId));
}

export async function softDeleteForProject(orgId, projectId, { at, by }) {
  await FloorPlan.updateMany({ orgId, projectId }, { $set: { deletedAt: at, deletedBy: by } });
}

// ── Resolution (plan + live unit status per hotspot) ────────────────────────────

/**
 * Plan with every hotspot resolved to its current target. Typical floor plans need `floor`
 * (defaults to the plan's first floor). `audience: 'public'` applies the website rules:
 * blocked/cancelled units become { status: 'unavailable' } with no details.
 */
export async function resolvePlan(orgId, fp, { floor, audience = 'staff', project }) {
  const now = new Date();
  const proj = project ?? (await projects.getProject(orgId, fp.projectId));
  let floorUsed = null;
  let byPosition = new Map();
  if (fp.kind === 'floor') {
    floorUsed = floor ?? fp.floors[0];
    if (!fp.floors.includes(floorUsed)) {
      throw new BadRequestError(`This plan covers floors ${fp.floors.join(', ')}`, {
        code: 'FLOOR_NOT_IN_PLAN',
      });
    }
    const onFloor = await units.findUnitsOnFloor(orgId, fp.blockId, floorUsed);
    byPosition = new Map(onFloor.map((u) => [u.position, u]));
  }
  const ids = fp.hotspots.filter((h) => h.unitId).map((h) => String(h.unitId));
  const byId = new Map(
    (await units.findUnitsByIds(orgId, fp.projectId, ids)).map((u) => [String(u._id), u]),
  );
  const needBlocks = fp.hotspots.some((h) => h.blockId);
  const blockSummary = needBlocks
    ? await units.summarizeBlocks(orgId, fp.projectId, { now })
    : new Map();
  const blocks = needBlocks
    ? new Map((await projects.listBlocksOf(orgId, fp.projectId)).map((b) => [String(b._id), b]))
    : new Map();

  const unitView = (u) => {
    if (!u) return null;
    if (audience === 'public') {
      const status = publicStatus(effectiveStatus(u, now));
      return status === 'unavailable'
        ? { status: 'unavailable' }
        : units.toPublicUnit(u, proj, now);
    }
    return units.toUnit(u, { now });
  };

  const unitTarget = (base, u) => {
    const unit = unitView(u);
    // Never point the website at a hidden unit, not even by id.
    const hide = audience === 'public' && (!unit || unit.status === 'unavailable');
    return { ...base, ...(hide && { unitId: null }), target: { type: 'unit', unit } };
  };

  const hotspots = fp.hotspots.map((h) => {
    const base = hotspotOut(h);
    if (h.unitId) return unitTarget(base, byId.get(String(h.unitId)));
    if (h.position) return unitTarget(base, byPosition.get(h.position));
    if (h.blockId) {
      const b = blocks.get(String(h.blockId));
      return {
        ...base,
        target: b
          ? {
              type: 'block',
              block: {
                ...projects.toBlock(b),
                inventory: blockSummary.get(String(b._id)) ?? { total: 0, byStatus: {} },
              },
            }
          : null,
      };
    }
    return { ...base, target: null };
  });

  const media = await publicMediaMap(orgId, [fp.mediaId]);
  return { ...toFloorPlan(fp, media), floor: floorUsed, hotspots };
}

export async function getFloorPlan(orgId, id, { floor }) {
  return resolvePlan(orgId, await loadPlan(orgId, id), { floor, audience: 'staff' });
}

/** Public: the plan's project must be published. */
export async function getPublicFloorPlan(orgId, id, { floor }) {
  const fp = await loadPlan(orgId, id);
  const project = await projects.getProject(orgId, fp.projectId).catch(() => null);
  if (!project?.published) throw new NotFoundError('Floor plan not found');
  return resolvePlan(orgId, fp, { floor, audience: 'public', project });
}
