import mongoose from 'mongoose';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '#shared/errors/AppError.js';
import { withTransaction } from '#shared/db/withTransaction.js';
import { diffFields } from '#shared/utils/diff.js';
import { offsetMeta } from '#shared/utils/pagination.js';
import { landArea, sqftArea } from '#shared/utils/area.js';
import { audit, SYSTEM_ACTOR } from '#modules/audit/audit.service.js';
import { assertPublicMedia } from '#modules/media/media.service.js';
import * as projects from '#modules/projects/project.service.js';
import { emitUnitStatus } from '#sockets/index.js';
import { Unit } from './unit.model.js';
import { priceUnit } from './pricing.js';
import {
  canTransition,
  effectiveStatus,
  isSold,
  publicStatus,
  SOLD_STATUSES,
} from './unitStatus.js';
import { APARTMENT_FIELDS, PLOT_FIELDS, PRICE_FIELDS } from './unit.validation.js';

/**
 * Units (B2): CRUD, pricing, and the status machine. Status changes happen ONLY in
 * `transition()` — an atomic findOneAndUpdate whose filter carries the allowed from-state, so
 * concurrent holds/bookings can never both succeed (ARCHITECTURE §5).
 */
const log = logger.child({ module: 'units' });
const { ObjectId } = mongoose.Types;
const HOUR = 3_600_000;

const staleVersion = () =>
  new ConflictError('This record was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const idOrNull = (v) => (v ? String(v) : null);

// ── Serialization ───────────────────────────────────────────────────────────────

function activeHold(u, now) {
  if (u.status !== 'held' || !u.hold || new Date(u.hold.until) <= now) return null;
  return {
    by: String(u.hold.by),
    byName: u.hold.byName ?? null,
    at: u.hold.at,
    until: u.hold.until,
    note: u.hold.note ?? null,
    leadId: idOrNull(u.hold.leadId),
  };
}

function kindFields(u) {
  if (u.kind === 'plot') {
    return {
      plotNo: u.plotNo ?? null,
      road: u.road ?? null,
      roadWidthFt: u.roadWidthFt ?? null,
      landArea: u.landArea ?? null,
      dimensions: u.dimensions ?? null,
    };
  }
  return {
    floor: u.floor ?? null,
    position: u.position ?? null,
    typeLabel: u.typeLabel ?? null,
    bedrooms: u.bedrooms ?? null,
    bathrooms: u.bathrooms ?? null,
    balconies: u.balconies ?? null,
    saleableSqft: u.saleableSqft ?? null,
    saleableSqm: u.saleableSqm ?? null,
    carpetSqft: u.carpetSqft ?? null,
    carpetSqm: u.carpetSqm ?? null,
    parkingSlots: u.parkingSlots ?? 0,
  };
}

/** Staff view. `status` is the effective status (an expired hold reads as available). */
export function toUnit(u, { now = new Date(), price } = {}) {
  const status = effectiveStatus(u, now);
  return {
    id: String(u._id),
    projectId: String(u.projectId),
    blockId: String(u.blockId),
    kind: u.kind,
    code: u.code,
    ...kindFields(u),
    facing: u.facing ?? null,
    isCorner: Boolean(u.isCorner),
    features: u.features ?? [],
    layoutMediaId: idOrNull(u.layoutMediaId),
    sortOrder: u.sortOrder ?? 0,
    rateOverride: u.rateOverride ?? null,
    priceAdjustment: u.priceAdjustment?.amount ? u.priceAdjustment : null,
    listPrice: u.listPrice ?? null,
    ...(price !== undefined && { price }),
    status,
    hold: activeHold(u, now),
    blockReason: status === 'blocked' ? (u.blockReason ?? null) : null,
    blockNote: status === 'blocked' ? (u.blockNote ?? null) : null,
    statusChangedAt: u.statusChangedAt ?? null,
    version: u.__v ?? 0,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/** Website view: no hold details, no internal pricing; price only when the project allows. */
export function toPublicUnit(u, project, now = new Date()) {
  const status = publicStatus(effectiveStatus(u, now));
  const showPrice = project.publicPricing && (status === 'available' || status === 'held');
  return {
    id: String(u._id),
    blockId: String(u.blockId),
    kind: u.kind,
    code: u.code,
    ...kindFields(u),
    facing: u.facing ?? null,
    isCorner: Boolean(u.isCorner),
    features: u.features ?? [],
    layoutMediaId: idOrNull(u.layoutMediaId),
    status,
    price: showPrice ? (u.listPrice ?? null) : null,
  };
}

function deltaOf(u, now = new Date()) {
  const status = effectiveStatus(u, now);
  const hold = activeHold(u, now);
  return {
    staff: {
      unitId: String(u._id),
      projectId: String(u.projectId),
      code: u.code,
      status,
      hold: hold && { byName: hold.byName, until: hold.until },
      listPrice: u.listPrice ?? null,
      version: u.__v ?? 0,
      at: now,
    },
    public: { unitId: String(u._id), projectId: String(u.projectId), status: publicStatus(status) },
  };
}

/**
 * Side effects after status changes COMMIT: socket deltas + public-site revalidation.
 * Callers inside a transaction (B4) must call this after the commit, never inside.
 */
export async function announceUnitChanges(orgId, units) {
  const byProject = new Map();
  for (const u of units) {
    const k = String(u.projectId);
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(u);
  }
  for (const [projectId, list] of byProject) {
    try {
      emitUnitStatus(
        orgId,
        projectId,
        list.map((u) => deltaOf(u)),
      );
      await projects.revalidateProject(orgId, await projects.getProjectAccess(orgId, projectId));
    } catch (err) {
      log.warn({ err: { message: err.message }, projectId }, 'announce failed');
    }
  }
}

// ── Pricing ─────────────────────────────────────────────────────────────────────

function computePrice(unitLike, pricing) {
  const breakdown = priceUnit(unitLike, pricing);
  return { listPrice: breakdown?.total ?? null, breakdown };
}

/** Re-price every unsold unit of a project (after a rate-card change). Returns the count. */
export async function repriceProject(orgId, project) {
  const rows = await Unit.find({ orgId, projectId: project._id, status: { $nin: SOLD_STATUSES } })
    .select(
      'kind floor saleableSqft facing isCorner parkingSlots landArea roadWidthFt rateOverride priceAdjustment listPrice',
    )
    .lean();
  const now = new Date();
  const ops = [];
  for (const u of rows) {
    const { listPrice } = computePrice(u, project.pricing);
    if (listPrice === (u.listPrice ?? null)) continue;
    ops.push({
      updateOne: {
        filter: { orgId, _id: u._id, status: { $nin: SOLD_STATUSES } },
        update: { $set: { listPrice, priceComputedAt: now }, $inc: { __v: 1 } },
      },
    });
  }
  for (let i = 0; i < ops.length; i += 500) {
    await Unit.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }
  return ops.length;
}

// ── Queries used by other modules ───────────────────────────────────────────────

/** Per-project inventory counts (effective status) + lowest available price. */
export async function summarizeProjects(orgId, projectIds, { now = new Date() } = {}) {
  const out = new Map();
  if (!projectIds.length) return out;
  const rows = await Unit.aggregate([
    { $match: { orgId: oid(orgId), projectId: { $in: projectIds.map(oid) } } },
    {
      $project: {
        projectId: 1,
        listPrice: 1,
        s: {
          $cond: [
            { $and: [{ $eq: ['$status', 'held'] }, { $lte: ['$hold.until', now] }] },
            'available',
            '$status',
          ],
        },
      },
    },
    {
      $group: {
        _id: { p: '$projectId', s: '$s' },
        n: { $sum: 1 },
        minPrice: { $min: '$listPrice' },
      },
    },
  ]);
  for (const r of rows) {
    const k = String(r._id.p);
    if (!out.has(k)) out.set(k, { total: 0, byStatus: {}, availableFrom: null });
    const s = out.get(k);
    s.total += r.n;
    s.byStatus[r._id.s] = r.n;
    if (r._id.s === 'available') s.availableFrom = r.minPrice ?? null;
  }
  return out;
}

/** Per-block counts for master-plan hotspots that point at a building/sector. */
export async function summarizeBlocks(orgId, projectId, { now = new Date() } = {}) {
  const rows = await Unit.aggregate([
    { $match: { orgId: oid(orgId), projectId: oid(projectId) } },
    {
      $project: {
        blockId: 1,
        s: {
          $cond: [
            { $and: [{ $eq: ['$status', 'held'] }, { $lte: ['$hold.until', now] }] },
            'available',
            '$status',
          ],
        },
      },
    },
    { $group: { _id: { b: '$blockId', s: '$s' }, n: { $sum: 1 } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const k = String(r._id.b);
    if (!out.has(k)) out.set(k, { total: 0, byStatus: {} });
    out.get(k).total += r.n;
    out.get(k).byStatus[r._id.s] = r.n;
  }
  return out;
}

/** Units on hold (not expired) or sold — anything that blocks deleting a project. */
export function countCommitted(orgId, { projectId }) {
  return Unit.countDocuments({
    orgId,
    projectId,
    $or: [
      { status: { $in: SOLD_STATUSES } },
      { status: 'held', 'hold.until': { $gt: new Date() } },
    ],
  });
}

export function countInBlock(orgId, blockId) {
  return Unit.countDocuments({ orgId, blockId });
}

export function countOutsideFloors(orgId, blockId, lowest, highest) {
  const or = [];
  if (lowest != null) or.push({ floor: { $lt: lowest } });
  if (highest != null) or.push({ floor: { $gt: highest } });
  if (!or.length) return 0;
  return Unit.countDocuments({ orgId, blockId, $or: or });
}

export async function softDeleteProjectInventory(orgId, projectId, { at, by }) {
  await Unit.updateMany({ orgId, projectId }, { $set: { deletedAt: at, deletedBy: by } });
}

/** For floor plans: units of a project by id. */
export function findUnitsByIds(orgId, projectId, ids) {
  if (!ids.length) return [];
  return Unit.find({ orgId, projectId, _id: { $in: ids.map(oid) } }).lean();
}

/** For typical floor plans: the units at (block, floor) keyed by position. */
export function findUnitsOnFloor(orgId, blockId, floor) {
  return Unit.find({ orgId, blockId, floor, position: { $type: 'string' } }).lean();
}

// ── CRUD ────────────────────────────────────────────────────────────────────────

function assertKindFields(kind, input) {
  const foreign = kind === 'plot' ? APARTMENT_FIELDS : PLOT_FIELDS;
  const bad = foreign.filter((f) => input[f] !== undefined);
  if (bad.length) {
    throw new ValidationError(
      bad.map((path) => ({ path, message: `Not a ${kind} field`, code: 'FIELD_NOT_ALLOWED' })),
    );
  }
}

function assertPricePermission(user, input) {
  if (PRICE_FIELDS.some((f) => input[f] !== undefined) && !user.permissions.has(P.PRICING_WRITE)) {
    throw new ForbiddenError('Changing unit prices needs pricing permission', {
      details: { missing: [P.PRICING_WRITE] },
    });
  }
}

function assertFloorInBlock(block, floor) {
  if (floor == null) return;
  if (
    (block.lowestFloor != null && floor < block.lowestFloor) ||
    (block.highestFloor != null && floor > block.highestFloor)
  ) {
    throw new BadRequestError(
      `Floor ${floor} is outside building ${block.code} (${block.lowestFloor ?? '…'} to ${block.highestFloor ?? '…'})`,
      { code: 'FLOOR_OUT_OF_RANGE' },
    );
  }
}

function generateCode(kind, block, input) {
  if (kind === 'plot') return input.plotNo ? `${block.code}-${input.plotNo}` : null;
  return input.floor != null && input.position
    ? `${block.code}-${input.floor}${input.position}`
    : null;
}

/** Apply validated input onto a unit document (new or existing) and derive areas/price. */
function applyInput(doc, input, { kind, block, pricing }) {
  for (const [k, v] of Object.entries(input)) {
    if (k === 'landArea' || k === 'saleableSqft' || k === 'carpetSqft') continue;
    doc.set(k, v === null && k === 'position' ? undefined : v);
  }
  if (input.saleableSqft !== undefined) {
    doc.saleableSqft = input.saleableSqft ?? undefined;
    doc.saleableSqm = input.saleableSqft == null ? undefined : sqftArea(input.saleableSqft).sqm;
  }
  if (input.carpetSqft !== undefined) {
    doc.carpetSqft = input.carpetSqft ?? undefined;
    doc.carpetSqm = input.carpetSqft == null ? undefined : sqftArea(input.carpetSqft).sqm;
  }
  if (input.landArea !== undefined) {
    doc.landArea = input.landArea ? landArea(input.landArea.value, input.landArea.unit) : undefined;
  }
  if (!doc.code) {
    const code = generateCode(kind, block, doc);
    if (!code) {
      throw new ValidationError([
        { path: 'code', message: 'Give a code, or floor + position / plot number', code: 'custom' },
      ]);
    }
    doc.code = code;
  }
  if (kind === 'apartment' && doc.floor == null) {
    throw new ValidationError([{ path: 'floor', message: 'Floor is required', code: 'custom' }]);
  }
  const { listPrice } = computePrice(doc, pricing);
  if (listPrice !== (doc.listPrice ?? null) || doc.isNew) {
    doc.listPrice = listPrice;
    doc.priceComputedAt = new Date();
  }
}

async function loadContext(orgId, projectId, blockId) {
  const project = await projects.getProject(orgId, projectId);
  const block = await projects.getBlock(orgId, project._id, blockId);
  return { project, block };
}

export async function listUnits(
  orgId,
  projectId,
  { blockId, floor, status, bedrooms, q, page, limit },
) {
  await projects.getProject(orgId, projectId);
  const now = new Date();
  const filter = { orgId, projectId: oid(projectId) };
  if (blockId) filter.blockId = oid(blockId);
  if (floor !== undefined) filter.floor = floor;
  if (bedrooms !== undefined) filter.bedrooms = bedrooms;
  if (q) filter.code = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (status === 'sold') filter.status = { $in: SOLD_STATUSES };
  else if (status === 'available') {
    filter.$or = [{ status: 'available' }, { status: 'held', 'hold.until': { $lte: now } }];
  } else if (status === 'held') {
    filter.status = 'held';
    filter['hold.until'] = { $gt: now };
  } else if (status) filter.status = status;

  const [rows, total] = await Promise.all([
    Unit.find(filter)
      .sort({ blockId: 1, floor: -1, sortOrder: 1, code: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Unit.countDocuments(filter),
  ]);
  return { items: rows.map((u) => toUnit(u, { now })), meta: offsetMeta({ page, limit }, total) };
}

async function loadUnit(orgId, id) {
  const u = await Unit.findOne({ orgId, _id: id }).lean();
  if (!u) throw new NotFoundError('Unit not found');
  return u;
}

export async function getUnitDetail(orgId, id) {
  const u = await loadUnit(orgId, id);
  const project = await projects.getProject(orgId, u.projectId);
  return toUnit(u, { price: priceUnit(u, project.pricing) });
}

async function checkUnitMedia(orgId, input) {
  if (input.layoutMediaId) await assertPublicMedia(orgId, [input.layoutMediaId], { kind: 'image' });
}

export async function createUnit({ orgId, projectId, input, user, ctx }) {
  const { project, block } = await loadContext(orgId, projectId, input.blockId);
  assertKindFields(project.kind, input);
  assertPricePermission(user, input);
  if (project.kind === 'apartment') assertFloorInBlock(block, input.floor);
  await checkUnitMedia(orgId, input);

  const doc = new Unit({
    orgId,
    projectId: project._id,
    kind: project.kind,
    createdBy: user.id,
    statusChangedBy: user.id,
  });
  applyInput(
    doc,
    { ...input, blockId: block._id },
    { kind: project.kind, block, pricing: project.pricing },
  );
  await doc.save();
  await audit(ctx, 'unit.create', {
    entity: { type: 'Unit', id: doc._id },
    meta: { projectId: String(project._id), code: doc.code },
  });
  await projects.revalidateProject(orgId, project);
  return toUnit(doc.toObject());
}

/** All-or-nothing bulk create (one transaction) — used by the inventory grid generator. */
export async function bulkCreateUnits({ orgId, projectId, inputs, user, ctx }) {
  const project = await projects.getProject(orgId, projectId);
  const blocks = new Map(
    (await projects.listBlocksOf(orgId, project._id)).map((b) => [String(b._id), b]),
  );

  const docs = inputs.map((input, i) => {
    const at = (e) => {
      if (e instanceof ValidationError) {
        e.details = e.details.map((d) => ({ ...d, path: `units.${i}.${d.path}` }));
      } else if (e instanceof AppError) {
        e.details = { index: i, ...(e.details ?? {}) };
      }
      return e;
    };
    try {
      const block = blocks.get(String(input.blockId));
      if (!block) throw new NotFoundError('Block not found');
      assertKindFields(project.kind, input);
      assertPricePermission(user, input);
      if (project.kind === 'apartment') assertFloorInBlock(block, input.floor);
      const doc = new Unit({
        orgId,
        projectId: project._id,
        kind: project.kind,
        createdBy: user.id,
        statusChangedBy: user.id,
      });
      applyInput(
        doc,
        { ...input, blockId: block._id },
        { kind: project.kind, block, pricing: project.pricing },
      );
      return doc;
    } catch (e) {
      throw at(e);
    }
  });

  const codes = docs.map((d) => d.code);
  const dupAt = codes.findIndex((c, i) => codes.indexOf(c) !== i);
  if (dupAt !== -1) {
    throw new ValidationError([
      {
        path: `units.${dupAt}.code`,
        message: `Duplicate code ${codes[dupAt]} in this batch`,
        code: 'custom',
      },
    ]);
  }
  const layoutIds = inputs.map((x) => x.layoutMediaId).filter(Boolean);
  if (layoutIds.length) await assertPublicMedia(orgId, layoutIds, { kind: 'image' });

  await withTransaction(async (session) => {
    await Unit.insertMany(docs, { session, ordered: true });
    await audit(ctx, 'unit.bulk_create', {
      entity: { type: 'Project', id: project._id },
      meta: { count: docs.length, first: codes[0], last: codes.at(-1) },
      session,
    });
  });
  await projects.revalidateProject(orgId, project);
  return { created: docs.length, items: docs.map((d) => toUnit(d.toObject())) };
}

const UNIT_AUDITED = [
  'code',
  'blockId',
  ...APARTMENT_FIELDS,
  ...PLOT_FIELDS,
  'facing',
  'isCorner',
  'features',
  'layoutMediaId',
  'sortOrder',
  ...PRICE_FIELDS,
  'listPrice',
];

/** Fields frozen once a booking exists (the booking holds the price snapshot). */
const LOCKED_WHEN_SOLD = [
  'blockId',
  'floor',
  'position',
  'saleableSqft',
  'landArea',
  'parkingSlots',
  'facing',
  'isCorner',
  'roadWidthFt',
  ...PRICE_FIELDS,
];

export async function updateUnit({ orgId, id, patch, user, ctx }) {
  const doc = await Unit.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Unit not found');
  if (doc.__v !== patch.version) throw staleVersion();
  const { version: _v, ...input } = patch;

  assertKindFields(doc.kind, input);
  assertPricePermission(user, input);
  if (isSold(doc.status)) {
    const locked = LOCKED_WHEN_SOLD.filter((f) => input[f] !== undefined);
    if (locked.length) {
      throw new ConflictError('This unit is sold — its price-affecting details are locked', {
        code: 'UNIT_LOCKED',
        details: locked.map((path) => ({ path, message: 'Locked after booking' })),
      });
    }
  }

  const project = await projects.getProject(orgId, doc.projectId);
  const block = await projects.getBlock(orgId, project._id, input.blockId ?? doc.blockId);
  if (doc.kind === 'apartment') assertFloorInBlock(block, input.floor ?? doc.floor);
  await checkUnitMedia(orgId, input);

  const before = doc.toObject();
  applyInput(doc, input, {
    kind: doc.kind,
    block,
    pricing: isSold(doc.status) ? null : project.pricing,
  });
  if (isSold(doc.status)) doc.listPrice = before.listPrice; // never re-price a sold unit
  await doc.save();

  const diff = diffFields(before, doc.toObject(), UNIT_AUDITED);
  if (diff) await audit(ctx, 'unit.update', { entity: { type: 'Unit', id: doc._id }, diff });
  await projects.revalidateProject(orgId, project);
  return toUnit(doc.toObject());
}

export async function deleteUnit({ orgId, id, ctx }) {
  const doc = await Unit.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Unit not found');
  const status = effectiveStatus(doc);
  if (status !== 'available' && status !== 'blocked') {
    throw new ConflictError('Only available or blocked units can be deleted', {
      code: 'UNIT_IN_USE',
      details: { status },
    });
  }
  await doc.softDelete(ctx.actor.id ?? null);
  await audit(ctx, 'unit.delete', {
    entity: { type: 'Unit', id: doc._id },
    meta: { code: doc.code },
  });
  await projects.revalidateProject(orgId, await projects.getProjectAccess(orgId, doc.projectId));
}

// ── Status machine ──────────────────────────────────────────────────────────────

const AVAILABLE_NOW = (now) => ({
  $or: [{ status: 'available' }, { status: 'held', 'hold.until': { $lte: now } }],
});

async function conflict(orgId, unitId, session) {
  const cur = await Unit.findOne({ orgId, _id: unitId })
    .select('status hold')
    .session(session ?? null)
    .lean();
  if (!cur) return new NotFoundError('Unit not found');
  return new ConflictError('The unit is not in a state that allows this', {
    code: 'UNIT_STATE_CONFLICT',
    details: {
      status: effectiveStatus(cur),
      heldUntil: activeHold(cur, new Date())?.until ?? null,
    },
  });
}

/**
 * The one place status changes. `match` is the from-state filter; `to` must be reachable
 * from every state `match` can select (checked against TRANSITIONS).
 * With `session`, side effects are skipped — call announceUnitChanges() after commit.
 */
async function transition({
  orgId,
  unitId,
  match,
  from,
  to,
  set = {},
  ctx,
  action,
  meta,
  session,
}) {
  for (const f of from) {
    if (f !== to && !canTransition(f, to)) throw new Error(`Illegal transition ${f} → ${to}`);
  }
  const now = new Date();
  const u = await Unit.findOneAndUpdate(
    { orgId, _id: unitId, ...match },
    {
      $set: { status: to, statusChangedAt: now, statusChangedBy: ctx.actor.id ?? null, ...set },
      $inc: { __v: 1 },
    },
    { returnDocument: 'after', lean: true, ...(session && { session }) },
  );
  if (!u) throw await conflict(orgId, unitId, session);
  await audit(ctx, action, {
    entity: { type: 'Unit', id: u._id },
    meta: { code: u.code, to, ...meta },
    ...(session && { session }),
  });
  if (!session) await announceUnitChanges(orgId, [u]);
  return u;
}

/**
 * Generic transition for later phases (booking, allotment, cancellation…) — B4 calls this
 * inside its transaction. Reaching `to` from any state the machine allows.
 */
export function transitionUnit({ orgId, unitId, from, to, set, ctx, action, meta, session }) {
  return transition({
    orgId,
    unitId,
    match: { status: { $in: from } },
    from,
    to,
    set,
    ctx,
    action: action ?? `unit.${to}`,
    meta,
    session,
  });
}

async function assertHoldCap(orgId, user, now) {
  const cap = env.UNIT_HOLD_MAX_PER_USER;
  if (!cap) return;
  const n = await Unit.countDocuments({
    orgId,
    status: 'held',
    'hold.by': oid(user.id),
    'hold.until': { $gt: now },
  });
  if (n >= cap) {
    throw new ConflictError(`You already hold ${n} units — release one first`, {
      code: 'HOLD_LIMIT',
      details: { limit: cap },
    });
  }
}

export async function holdUnit({ orgId, unitId, user, hours, note, leadId, ctx }) {
  const now = new Date();
  await assertHoldCap(orgId, user, now);
  const h = hours ?? env.UNIT_HOLD_DEFAULT_HOURS;
  const u = await transition({
    orgId,
    unitId,
    match: AVAILABLE_NOW(now),
    from: ['available', 'held'],
    to: 'held',
    set: {
      hold: {
        by: oid(user.id),
        byName: user.name,
        at: now,
        until: new Date(now.getTime() + h * HOUR),
        ...(note && { note }),
        leadId: leadId ? oid(leadId) : null,
      },
    },
    ctx,
    action: 'unit.hold',
    meta: { hours: h, ...(leadId && { leadId }) },
  });
  return toUnit(u);
}

/** Managers (units:write) extend a live hold. */
export async function extendHold({ orgId, unitId, hours, ctx }) {
  const now = new Date();
  const until = new Date(now.getTime() + hours * HOUR);
  const u = await Unit.findOneAndUpdate(
    { orgId, _id: unitId, status: 'held', 'hold.until': { $gt: now } },
    { $set: { 'hold.until': until }, $inc: { __v: 1 } },
    { returnDocument: 'after', lean: true },
  );
  if (!u) throw await conflict(orgId, unitId);
  await audit(ctx, 'unit.hold_extend', {
    entity: { type: 'Unit', id: u._id },
    meta: { code: u.code, until },
  });
  await announceUnitChanges(orgId, [u]);
  return toUnit(u);
}

/** The holder, or anyone with units:write, releases a hold. */
export async function releaseUnit({ orgId, unitId, user, ctx }) {
  const manager = user.permissions.has(P.UNITS_WRITE);
  const match = { status: 'held', ...(!manager && { 'hold.by': oid(user.id) }) };
  try {
    const u = await transition({
      orgId,
      unitId,
      match,
      from: ['held'],
      to: 'available',
      set: { hold: null },
      ctx,
      action: 'unit.release',
    });
    return toUnit(u);
  } catch (err) {
    if (!manager && err.code === 'UNIT_STATE_CONFLICT' && err.details?.status === 'held') {
      throw new ForbiddenError('Only the person holding this unit or a manager can release it', {
        code: 'NOT_HOLDER',
      });
    }
    throw err;
  }
}

export async function blockUnit({ orgId, unitId, reason, note, ctx }) {
  const now = new Date();
  const u = await transition({
    orgId,
    unitId,
    match: AVAILABLE_NOW(now),
    from: ['available'],
    to: 'blocked',
    set: { hold: null, blockReason: reason, blockNote: note ?? null },
    ctx,
    action: 'unit.block',
    meta: { reason },
  });
  return toUnit(u);
}

export async function unblockUnit({ orgId, unitId, ctx }) {
  const u = await transition({
    orgId,
    unitId,
    match: { status: 'blocked' },
    from: ['blocked'],
    to: 'available',
    set: { blockReason: null, blockNote: null },
    ctx,
    action: 'unit.unblock',
  });
  return toUnit(u);
}

/**
 * Job: flip expired holds back to available (the lazy read check covers the gap between
 * runs). Each unit is a conditional update, so a hold renewed meanwhile is never touched.
 */
export async function expireHolds(orgId, { batch = 500 } = {}) {
  const now = new Date();
  const due = await Unit.find({ orgId, status: 'held', 'hold.until': { $lte: now } })
    .select('_id')
    .limit(batch)
    .lean();
  const changed = [];
  for (const { _id } of due) {
    const u = await Unit.findOneAndUpdate(
      { orgId, _id, status: 'held', 'hold.until': { $lte: now } },
      {
        $set: { status: 'available', hold: null, statusChangedAt: now, statusChangedBy: null },
        $inc: { __v: 1 },
      },
      { returnDocument: 'after', lean: true },
    );
    if (!u) continue;
    changed.push(u);
    await audit({ orgId, actor: SYSTEM_ACTOR }, 'unit.hold_expired', {
      entity: { type: 'Unit', id: u._id },
      meta: { code: u.code },
    });
  }
  if (changed.length) {
    await announceUnitChanges(orgId, changed);
    log.info({ expired: changed.length }, 'Expired unit holds');
  }
  return changed.length;
}

// ── Public (website) ────────────────────────────────────────────────────────────

export async function listPublicUnits(
  orgId,
  project,
  { blockId, floor, status, bedrooms, page, limit },
) {
  const now = new Date();
  const filter = { orgId, projectId: project._id, status: { $nin: ['blocked', 'cancelled'] } };
  if (blockId) filter.blockId = oid(blockId);
  if (floor !== undefined) filter.floor = floor;
  if (bedrooms !== undefined) filter.bedrooms = bedrooms;
  if (status === 'available') filter.$or = AVAILABLE_NOW(now).$or;
  else if (status === 'held') Object.assign(filter, { status: 'held', 'hold.until': { $gt: now } });
  else if (status === 'sold') filter.status = { $in: SOLD_STATUSES };

  const [rows, total] = await Promise.all([
    Unit.find(filter)
      .sort({ blockId: 1, floor: -1, sortOrder: 1, code: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Unit.countDocuments(filter),
  ]);
  return {
    items: rows.map((u) => toPublicUnit(u, project, now)),
    meta: offsetMeta({ page, limit }, total),
  };
}

/** A unit on the website: its project must be published and the unit not blocked/cancelled. */
export async function getPublicUnit(orgId, id) {
  const u = await Unit.findOne({
    orgId,
    _id: id,
    status: { $nin: ['blocked', 'cancelled'] },
  }).lean();
  if (!u) throw new NotFoundError('Unit not found');
  const project = await projects.getProject(orgId, u.projectId).catch(() => null);
  if (!project?.published) throw new NotFoundError('Unit not found');
  return { unit: u, project };
}
