import mongoose from 'mongoose';
import { P } from '#shared/auth/permissions.js';
import { withTransaction } from '#shared/db/withTransaction.js';
import { BadRequestError, ConflictError } from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { audit } from '#modules/audit/audit.service.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { getProjectAccess } from '#modules/projects/project.service.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';
import { Lead } from './lead.model.js';
import { AUTO_REPLY_MAX_SEGMENTS, checkAutoReply } from './autoReplyText.js';
import { DEFAULT_STAGES, LeadStage } from './leadStage.model.js';
import { LeadSettings } from './leadSettings.model.js';

/**
 * Pipeline stages, CRM settings and round-robin assignment (B3).
 */
const { ObjectId } = mongoose.Types;

const staleVersion = () =>
  new ConflictError('This record was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

// ── Stages ──────────────────────────────────────────────────────────────────────

export function toStage(s, count) {
  return {
    id: String(s._id),
    pipeline: s.pipeline,
    key: s.key,
    name: s.name,
    nameBn: s.nameBn ?? null,
    kind: s.kind,
    color: s.color,
    order: s.order,
    ...(count !== undefined && { count }),
  };
}

/** Stages of one pipeline in order; the defaults are created on first use (race-safe). */
export async function getStages(orgId, pipeline) {
  const find = () => LeadStage.find({ orgId, pipeline }).sort({ order: 1 }).lean();
  let stages = await find();
  if (stages.length) return stages;
  try {
    await LeadStage.insertMany(
      DEFAULT_STAGES[pipeline].map((s, i) => ({ ...s, orgId, pipeline, order: i })),
      { ordered: false },
    );
  } catch (err) {
    if (err?.code !== 11000 && !err?.writeErrors?.every((e) => e.code === 11000)) throw err;
  }
  stages = await find();
  return stages;
}

/** Where new leads land: the first open stage. */
export function entryStage(stages) {
  return stages.find((s) => s.kind === 'open');
}

export async function getStage(orgId, stageId) {
  const s = await LeadStage.findOne({ orgId, _id: stageId }).lean();
  if (!s) throw new BadRequestError('Unknown pipeline stage', { code: 'UNKNOWN_STAGE' });
  return s;
}

export async function listStagesWithCounts(orgId, pipeline) {
  const stages = await getStages(orgId, pipeline);
  const counts = await Lead.aggregate([
    { $match: { orgId: new ObjectId(String(orgId)), type: pipeline } },
    { $group: { _id: '$stageId', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  return stages.map((s) => toStage(s, byId.get(String(s._id)) ?? 0));
}

const keyFrom = (name, taken) => {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'stage';
  let key = base;
  for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
  taken.add(key);
  return key;
};

/**
 * Replace a pipeline's stage list (order = array order). Existing stages are matched by `id`;
 * stages missing from the list are removed. Guards: ≥ 1 open, exactly 1 won, ≥ 1 lost; a stage
 * that holds leads can't be removed (409 STAGE_IN_USE) or change kind (409 STAGE_KIND_LOCKED).
 */
export async function replaceStages({ orgId, pipeline, stages: input, ctx }) {
  const kinds = input.map((s) => s.kind);
  if (
    !kinds.includes('open') ||
    kinds.filter((k) => k === 'won').length !== 1 ||
    !kinds.includes('lost')
  ) {
    throw new BadRequestError(
      'A pipeline needs at least one open stage, exactly one won and at least one lost stage',
      {
        code: 'INVALID_PIPELINE',
      },
    );
  }

  const current = await getStages(orgId, pipeline);
  const byId = new Map(current.map((s) => [String(s._id), s]));
  const unknown = input.filter((s) => s.id && !byId.has(s.id));
  if (unknown.length) throw new BadRequestError('Unknown stage id', { code: 'UNKNOWN_STAGE' });

  const counts = await Lead.aggregate([
    { $match: { orgId: new ObjectId(String(orgId)), type: pipeline } },
    { $group: { _id: '$stageId', n: { $sum: 1 } } },
  ]).option({ withDeleted: true }); // merged/deleted leads still point at their stage
  const used = new Map(counts.map((c) => [String(c._id), c.n]));

  const keptIds = new Set(input.filter((s) => s.id).map((s) => s.id));
  const removed = current.filter((s) => !keptIds.has(String(s._id)));
  const blocked = removed.filter((s) => used.get(String(s._id)));
  if (blocked.length) {
    throw new ConflictError('Move the leads out of a stage before removing it', {
      code: 'STAGE_IN_USE',
      details: blocked.map((s) => ({ path: s.key, message: `${used.get(String(s._id))} leads` })),
    });
  }
  const kindLocked = input.filter((s) => s.id && byId.get(s.id).kind !== s.kind && used.get(s.id));
  if (kindLocked.length) {
    throw new ConflictError("A stage that holds leads can't change between open, won and lost", {
      code: 'STAGE_KIND_LOCKED',
      details: kindLocked.map((s) => ({ path: byId.get(s.id).key, message: 'Has leads' })),
    });
  }

  const taken = new Set(current.filter((s) => keptIds.has(String(s._id))).map((s) => s.key));
  await withTransaction(async (session) => {
    if (removed.length) {
      await LeadStage.deleteMany({ orgId, _id: { $in: removed.map((s) => s._id) } }).session(
        session,
      );
    }
    // Two passes avoid transient (orgId, pipeline, key) clashes — keys never change for kept stages.
    for (const [order, s] of input.entries()) {
      const fields = {
        name: s.name,
        nameBn: s.nameBn ?? null,
        kind: s.kind,
        color: s.color,
        order,
      };
      if (s.id) {
        await LeadStage.updateOne({ orgId, _id: s.id }, { $set: fields }).session(session);
      } else {
        await LeadStage.create([{ ...fields, orgId, pipeline, key: keyFrom(s.name, taken) }], {
          session,
        });
      }
    }
    await audit(ctx, 'pipeline.update', {
      meta: { pipeline, before: current.map((s) => s.key), after: input.map((s) => s.name) },
      session,
    });
  });
  return listStagesWithCounts(orgId, pipeline);
}

// ── Settings ────────────────────────────────────────────────────────────────────

export async function getSettings(orgId) {
  const found = await LeadSettings.findOne({ orgId }).lean();
  if (found) return found;
  try {
    return (await LeadSettings.create({ orgId })).toObject();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return LeadSettings.findOne({ orgId }).lean();
  }
}

export function toSettings(s) {
  return {
    version: s.__v ?? 0,
    assignment: {
      mode: s.assignment.mode,
      projectPools: (s.assignment.projectPools ?? []).map((p) => ({
        projectId: String(p.projectId),
        userIds: p.userIds.map(String),
      })),
    },
    sla: {
      enabled: s.sla.enabled,
      firstResponseMinutes: s.sla.firstResponseMinutes,
      officeStart: s.sla.officeStart,
      officeEnd: s.sla.officeEnd,
      weekend: s.sla.weekend,
    },
    autoReply: {
      enabled: s.autoReply.enabled,
      textBn: s.autoReply.textBn,
      textEn: s.autoReply.textEn,
    },
  };
}

export async function updateSettings({ orgId, patch, ctx }) {
  await getSettings(orgId); // make sure the document exists
  const doc = await LeadSettings.findOne({ orgId });
  if (doc.__v !== patch.version) throw staleVersion();

  const pools = patch.assignment?.projectPools;
  if (pools) {
    for (const pool of pools) {
      if (!(await getProjectAccess(orgId, pool.projectId))) {
        throw new BadRequestError('Unknown project in a team', { code: 'UNKNOWN_PROJECT' });
      }
      const staff = await listActiveStaffWith(orgId, P.LEADS_READ_OWN, { ids: pool.userIds });
      if (staff.length !== new Set(pool.userIds).size) {
        throw new BadRequestError('A team member is not an active sales user', {
          code: 'INVALID_ASSIGNEE',
        });
      }
    }
  }

  const before = toSettings(doc.toObject());
  if (patch.assignment?.mode) doc.assignment.mode = patch.assignment.mode;
  if (pools) doc.assignment.projectPools = pools;
  if (patch.sla) Object.assign(doc.sla, patch.sla);
  if (patch.autoReply) {
    Object.assign(doc.autoReply, patch.autoReply);
    // Each SMS segment costs money: keep the filled-in text within AUTO_REPLY_MAX_SEGMENTS.
    const org = await Organization.findOne({ _id: orgId }).select('name nameBn').lean();
    const details = [];
    for (const [field, locale] of [
      ['textBn', 'bn'],
      ['textEn', 'en'],
    ]) {
      if (patch.autoReply[field] === undefined) continue;
      const c = checkAutoReply(doc.autoReply[field], { org, locale });
      if (!c.ok)
        details.push({
          path: `autoReply.${field}`,
          message: `${c.segments} SMS long — keep it within ${AUTO_REPLY_MAX_SEGMENTS}`,
        });
    }
    if (details.length)
      throw new BadRequestError('Auto-reply text is too long', {
        code: 'AUTO_REPLY_TOO_LONG',
        details,
      });
  }
  if (doc.sla.officeEnd <= doc.sla.officeStart) {
    throw new BadRequestError('Office hours must end after they start', {
      code: 'INVALID_OFFICE_HOURS',
    });
  }
  await doc.save();

  const after = toSettings(doc.toObject());
  const diff = diffFields(before, after, ['assignment', 'sla', 'autoReply']);
  if (diff) await audit(ctx, 'lead_settings.update', { diff });
  return after;
}

// ── Round-robin assignment ──────────────────────────────────────────────────────

/**
 * Next owner for a new lead, or null (manual mode, or nobody available → "unassigned" queue).
 * Pool: the project's team when one is set (its active members), else every active sales
 * executive. The cursor ("who got the last one") moves with a compare-and-set, so two leads
 * arriving together go to two different people.
 */
export async function pickAssignee(orgId, { projectId } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const settings = await getSettings(orgId);
    if (settings.assignment.mode !== 'round_robin') return null;

    const team = projectId
      ? settings.assignment.projectPools?.find((p) => String(p.projectId) === String(projectId))
      : null;
    const pool = team
      ? await listActiveStaffWith(orgId, P.LEADS_READ_OWN, { ids: team.userIds })
      : await listActiveStaffWith(orgId, P.LEADS_READ_OWN, { roles: ['sales_executive'] });
    if (!pool.length) return null;

    const key = team ? String(projectId) : 'default';
    const raw = settings.assignment.cursors;
    const last = raw instanceof Map ? raw.get(key) : raw?.[key];
    const lastId = last ? String(last) : null;
    const next = (lastId && pool.find((u) => u.id > lastId)) || pool[0];

    const path = `assignment.cursors.${key}`;
    const res = await LeadSettings.updateOne(
      { orgId, [path]: lastId ? new ObjectId(lastId) : { $exists: false } },
      { $set: { [path]: new ObjectId(next.id) } },
    );
    if (res.modifiedCount === 1 || (lastId === next.id && res.matchedCount === 1)) return next.id;
  }
  return null; // heavy contention — leave it for a manager rather than guess
}
