import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import { withTransaction } from '#shared/db/withTransaction.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#shared/errors/AppError.js';
import { landArea } from '#shared/utils/area.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { normalizePhone } from '#shared/utils/phone.js';
import { rankBetween } from '#shared/utils/rank.js';
import { audit } from '#modules/audit/audit.service.js';
import { notify } from '#modules/notifications/notification.service.js';
import {
  getProjectAccess,
  getPublishedProjectBySlug,
  projectSummaries,
} from '#modules/projects/project.service.js';
import { unitRefs } from '#modules/units/unit.service.js';
import { listActiveStaffWith, userNames } from '#modules/users/user.service.js';
import { Lead, openKeyOf } from './lead.model.js';
import { LeadActivity } from './leadActivity.model.js';
import { LeadTask } from './leadTask.model.js';
import {
  entryStage,
  getSettings,
  getStage,
  getStages,
  pickAssignee,
  toStage,
} from './pipeline.service.js';
import { localeFromPage, sendAutoReply } from './autoReply.js';
import { slaDueAt } from './sla.js';

/**
 * Leads (B3): intake + dedupe, visibility, edits, Kanban moves, assignment, merge, export.
 * Activities and tasks live in followup.service.js.
 *
 * Visibility (object-level, ARCHITECTURE §9): without `leads:read_all` a user sees only leads
 * assigned to them; anything else is a 404 (not 403), so ids can't be probed.
 */
const log = logger.child({ module: 'leads' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const idOrNull = (v) => (v ? String(v) : null);
const DAY = 86_400_000;
const DHAKA_OFFSET = 6 * 3_600_000;

const staleVersion = () =>
  new ConflictError('This lead was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

export const canReadAll = (user) => user.permissions.has(P.LEADS_READ_ALL);
export const canAssign = (user) => user.permissions.has(P.LEADS_ASSIGN);

// ── Serialization ───────────────────────────────────────────────────────────────

function landOut(land) {
  if (!land) return null;
  const empty =
    !land.location &&
    !land.area &&
    land.roadWidthFt == null &&
    !land.ownership &&
    !land.mutation &&
    !land.expectedShare;
  if (empty) return null;
  return {
    location: land.location ?? null,
    area: land.area ?? null,
    roadWidthFt: land.roadWidthFt ?? null,
    ownership: land.ownership ?? null,
    mutation: land.mutation ?? null,
    expectedShare: land.expectedShare ?? null,
  };
}

/** refs = { users: Map, projects: Map, units: Map, stages: Map } (any may be missing). */
export function toLead(l, refs = {}, now = new Date()) {
  const projectId = idOrNull(l.interest?.projectId);
  const unitId = idOrNull(l.interest?.unitId);
  const assigneeId = idOrNull(l.assigneeId);
  const stage = refs.stages?.get(String(l.stageId));
  return {
    id: String(l._id),
    version: l.__v ?? 0,
    type: l.type,
    name: l.name,
    phone: l.phone,
    altPhone: l.altPhone ?? null,
    email: l.email ?? null,
    source: l.source,
    sourceDetail: {
      page: l.sourceDetail?.page ?? null,
      campaign: l.sourceDetail?.campaign ?? null,
      medium: l.sourceDetail?.medium ?? null,
      formName: l.sourceDetail?.formName ?? null,
      referrer: l.sourceDetail?.referrer ?? null,
    },
    message: l.message ?? null,
    interest: {
      projectId,
      project: projectId ? (refs.projects?.get(projectId) ?? null) : null,
      unitId,
      unitCode: unitId ? (refs.units?.get(unitId)?.code ?? null) : null,
      bedrooms: l.interest?.bedrooms ?? null,
      budgetMin: l.interest?.budgetMin ?? null,
      budgetMax: l.interest?.budgetMax ?? null,
    },
    land: landOut(l.land),
    stageId: String(l.stageId),
    stage: stage ? toStage(stage) : undefined,
    status: l.status,
    rank: l.rank,
    lostReason: l.lostReason ?? null,
    lostNote: l.lostNote ?? null,
    closedAt: l.closedAt ?? null,
    assigneeId,
    assigneeName: assigneeId ? (refs.users?.get(assigneeId) ?? null) : null,
    assignedAt: l.assignedAt ?? null,
    slaDueAt: l.slaDueAt ?? null,
    firstResponseAt: l.firstResponseAt ?? null,
    slaEscalatedAt: l.slaEscalatedAt ?? null,
    slaBreached: Boolean(
      l.slaDueAt &&
      (l.firstResponseAt
        ? l.firstResponseAt > l.slaDueAt
        : l.status === 'open' && now > l.slaDueAt),
    ),
    lastActivityAt: l.lastActivityAt ?? null,
    nextFollowUpAt: l.nextFollowUpAt ?? null,
    enquiryCount: l.enquiryCount ?? 1,
    lastEnquiryAt: l.lastEnquiryAt ?? null,
    tags: l.tags ?? [],
    previousLeadId: idOrNull(l.previousLeadId),
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

/** Load names/projects/units/stages for a batch of leads in 3–4 queries. */
async function refsFor(orgId, leads, { stages } = {}) {
  const [users, projects, units] = await Promise.all([
    userNames(
      orgId,
      leads.map((l) => l.assigneeId),
    ),
    projectSummaries(
      orgId,
      leads.map((l) => l.interest?.projectId),
    ),
    unitRefs(
      orgId,
      leads.map((l) => l.interest?.unitId),
    ),
  ]);
  return {
    users,
    projects,
    units,
    stages: stages ? new Map(stages.map((s) => [String(s._id), s])) : undefined,
  };
}

export async function serializeLeads(orgId, leads, opts) {
  const refs = await refsFor(orgId, leads, opts);
  const now = new Date();
  return leads.map((l) => toLead(l, refs, now));
}

// ── Access ──────────────────────────────────────────────────────────────────────

/** Mongo filter fragment limiting what `user` may see. */
export function scopeFor(user) {
  return canReadAll(user) ? {} : { assigneeId: oid(user.id) };
}

/** A lead the user may see, as a lean object, or 404. */
export async function getVisibleLead(orgId, user, id) {
  const l = await Lead.findOne({ orgId, _id: id, ...scopeFor(user) }).lean();
  if (!l) throw new NotFoundError('Lead not found');
  return l;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────

function phoneOrThrow(input, field = 'phone') {
  const e164 = normalizePhone(input);
  if (!e164) {
    throw new BadRequestError('Invalid phone number', {
      code: 'INVALID_PHONE',
      details: [
        {
          path: field,
          message: 'Enter a Bangladesh mobile or an international number with +country code',
        },
      ],
    });
  }
  return e164;
}

async function checkInterest(orgId, interest) {
  if (!interest) return;
  if (interest.projectId && !(await getProjectAccess(orgId, interest.projectId))) {
    throw new BadRequestError('Unknown project', { code: 'UNKNOWN_PROJECT' });
  }
  if (interest.unitId) {
    const ref = (await unitRefs(orgId, [interest.unitId])).get(String(interest.unitId));
    if (!ref) throw new BadRequestError('Unknown unit', { code: 'UNKNOWN_UNIT' });
    if (interest.projectId && ref.projectId !== String(interest.projectId)) {
      throw new BadRequestError('The unit is not in that project', {
        code: 'UNIT_PROJECT_MISMATCH',
      });
    }
    interest.projectId ??= ref.projectId; // a unit implies its project
  }
}

function landIn(land) {
  if (!land) return undefined;
  const out = { ...land };
  if (land.area) out.area = landArea(land.area.value, land.area.unit);
  return out;
}

/** Assignee chosen by a staff member: must be active staff who can own leads. */
async function checkAssignee(orgId, assigneeId) {
  const [u] = await listActiveStaffWith(orgId, P.LEADS_READ_OWN, { ids: [assigneeId] });
  if (!u) throw new BadRequestError('Pick an active sales user', { code: 'INVALID_ASSIGNEE' });
  return u;
}

async function topRank(orgId, stageId) {
  const first = await Lead.findOne({ orgId, stageId }).sort({ rank: 1 }).select('rank').lean();
  return rankBetween(null, first?.rank ?? null);
}

async function addActivity(
  orgId,
  leadId,
  type,
  { actorId = null, body = null, meta, at, session } = {},
) {
  const doc = { orgId, leadId, type, actorId, body, meta, at: at ?? new Date() };
  if (session) await LeadActivity.create([doc], { session });
  else await LeadActivity.create(doc);
}

async function managersOf(orgId) {
  return (await listActiveStaffWith(orgId, P.LEADS_ASSIGN)).map((u) => u.id);
}

async function notifyNewLead(orgId, lead, { assigneeId, excludeUserId } = {}) {
  const data = { leadId: String(lead._id), name: lead.name, type: lead.type, source: lead.source };
  if (assigneeId) {
    if (String(assigneeId) !== String(excludeUserId))
      await notify(orgId, [assigneeId], 'lead.assigned', data);
  } else {
    const managers = (await managersOf(orgId)).filter((id) => id !== String(excludeUserId));
    await notify(orgId, managers, 'lead.unassigned', data);
  }
}

// ── Intake (website, Meta, manual) ──────────────────────────────────────────────

/**
 * Repeat enquiry on an open lead: count it, keep the newest message on the timeline, fill
 * fields that were empty, and tell the owner. Atomic ($inc) — safe with concurrent enquiries.
 */
async function recordEnquiry(orgId, existing, input, { actorId = null } = {}) {
  const now = new Date();
  const set = { lastEnquiryAt: now };
  if (!existing.email && input.email) set.email = input.email;
  if (!existing.interest?.projectId && input.interest?.projectId)
    set['interest.projectId'] = oid(input.interest.projectId);
  if (!existing.interest?.unitId && input.interest?.unitId)
    set['interest.unitId'] = oid(input.interest.unitId);

  const lead = await Lead.findOneAndUpdate(
    { orgId, _id: existing._id },
    { $set: set, $inc: { enquiryCount: 1, __v: 1 } },
    { returnDocument: 'after', lean: true },
  );
  await addActivity(orgId, existing._id, 'enquiry', {
    actorId,
    body: input.message ?? null,
    meta: {
      source: input.source,
      page: input.sourceDetail?.page ?? null,
      projectId: input.interest?.projectId ? String(input.interest.projectId) : null,
    },
  });
  const data = {
    leadId: String(existing._id),
    name: existing.name,
    type: existing.type,
    source: input.source,
  };
  if (lead.assigneeId) await notify(orgId, [lead.assigneeId], 'lead.enquiry', data);
  else await notify(orgId, await managersOf(orgId), 'lead.enquiry', data);
  return lead;
}

/**
 * Create a lead, or record a repeat enquiry when an open lead with the same phone and type
 * exists (`duplicate: true`). Used by the website form, Meta Lead Ads and manual entry.
 *
 * input: normalized fields (phone in E.164, interest/land checked).
 * opts.assignee: undefined → round-robin; null → unassigned; id → that user.
 * opts.onDuplicate: 'enquiry' (integrations) | 'conflict' (staff: 409 DUPLICATE_LEAD).
 */
export async function intakeLead(
  orgId,
  input,
  { assignee, actorId = null, onDuplicate = 'enquiry', ctx } = {},
) {
  const key = openKeyOf(input.type, input.phone);
  const stages = await getStages(orgId, input.type);
  const stage = entryStage(stages);
  const settings = await getSettings(orgId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await Lead.findOne({ orgId, openKey: key }).lean();
    if (existing) {
      if (onDuplicate === 'conflict') return { duplicateOf: existing };
      return { lead: await recordEnquiry(orgId, existing, input, { actorId }), duplicate: true };
    }

    const previous = await Lead.findOne({ orgId, phone: input.phone, type: input.type })
      .sort({ createdAt: -1 })
      .select('_id')
      .lean();
    const assigneeId =
      assignee === undefined
        ? await pickAssignee(orgId, { projectId: input.interest?.projectId })
        : assignee;
    const now = new Date();
    try {
      const doc = await Lead.create({
        ...input,
        orgId,
        stageId: stage._id,
        status: 'open',
        rank: await topRank(orgId, stage._id),
        assigneeId,
        assignedAt: assigneeId ? now : null,
        slaDueAt: slaDueAt(now, settings.sla),
        lastEnquiryAt: now,
        openKey: key,
        previousLeadId: previous?._id ?? null,
        createdBy: actorId,
      });
      const lead = doc.toObject();
      await addActivity(orgId, lead._id, 'created', {
        actorId,
        body: input.message ?? null,
        meta: { source: input.source, page: input.sourceDetail?.page ?? null },
      });
      if (assigneeId) {
        await addActivity(orgId, lead._id, 'assigned', {
          meta: { to: String(assigneeId), auto: assignee === undefined },
        });
      }
      await notifyNewLead(orgId, lead, { assigneeId, excludeUserId: actorId });
      if (ctx && actorId) {
        await audit(ctx, 'lead.create', {
          entity: { type: 'Lead', id: lead._id },
          meta: { source: input.source },
        });
      }
      return { lead, duplicate: false };
    } catch (err) {
      // Lost the race to an identical enquiry — loop and record ours on the winner.
      if (err?.code === 11000 && err.keyPattern?.openKey) continue;
      throw err;
    }
  }
  throw new ConflictError('Please try again', { code: 'BUSY' });
}

/** POST /public/leads — the website enquiry form (bots are filtered in the route). */
export async function createWebsiteLead(orgId, body) {
  const phone = phoneOrThrow(body.phone);
  let projectId = null;
  if (body.projectSlug) {
    try {
      projectId = (await getPublishedProjectBySlug(orgId, body.projectSlug))._id;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err; // unknown slug: not the visitor's fault — keep the lead
    }
  }
  const interest = { projectId, unitId: null };
  if (body.unitId) {
    const ref = (await unitRefs(orgId, [body.unitId])).get(body.unitId);
    if (ref && (!projectId || ref.projectId === String(projectId))) {
      interest.unitId = oid(ref.id);
      interest.projectId = oid(ref.projectId);
    }
  }
  const input = {
    type: body.type,
    name: body.name,
    phone,
    email: body.email || null,
    source: 'website',
    sourceDetail: {
      page: body.page ?? null,
      campaign: body.utm?.campaign ?? null,
      // "google / cpc" — utm_source and utm_medium together
      medium: [body.utm?.source, body.utm?.medium].filter(Boolean).join(' / ') || null,
    },
    message: body.message ?? null,
    interest,
    land: body.type === 'landowner' ? landIn(body.land) : undefined,
  };
  const res = await intakeLead(orgId, input, { onDuplicate: 'enquiry' });
  if (!res.duplicate)
    await sendAutoReply(orgId, res.lead, { locale: localeFromPage(body.page, null) });
  return res;
}

/** Staff: manual entry. A duplicate open lead → 409 DUPLICATE_LEAD (with its id when visible). */
export async function createLead({ orgId, user, input, ctx }) {
  const body = { ...input };
  body.phone = phoneOrThrow(input.phone);
  if (input.altPhone) body.altPhone = phoneOrThrow(input.altPhone, 'altPhone');
  if (body.interest) body.interest = { ...body.interest };
  await checkInterest(orgId, body.interest);
  body.land = body.type === 'landowner' ? landIn(input.land) : undefined;
  delete body.assigneeId;

  // Who owns it: executives → themselves; people who can assign → their pick or round-robin.
  let assignee;
  if (input.assigneeId === undefined) assignee = canAssign(user) ? undefined : oid(user.id);
  else if (input.assigneeId === null || input.assigneeId !== user.id) {
    if (!canAssign(user)) throw new ForbiddenError('Only managers can assign leads to others');
    assignee = input.assigneeId ? oid((await checkAssignee(orgId, input.assigneeId)).id) : null;
  } else assignee = oid(user.id);

  const res = await intakeLead(orgId, body, {
    assignee,
    actorId: oid(user.id),
    onDuplicate: 'conflict',
    ctx,
  });
  if (res.duplicateOf) {
    const d = res.duplicateOf;
    const visible = canReadAll(user) || String(d.assigneeId) === user.id;
    const names = visible ? await userNames(orgId, [d.assigneeId]) : new Map();
    throw new ConflictError('An open lead with this phone number already exists', {
      code: 'DUPLICATE_LEAD',
      details: visible
        ? [
            {
              path: 'phone',
              message: 'Already a lead',
              leadId: String(d._id),
              assigneeName: names.get(String(d.assigneeId)) ?? null,
            },
          ]
        : [{ path: 'phone', message: 'Already a lead owned by someone else' }],
    });
  }
  return getLeadDetail(orgId, user, String(res.lead._id));
}

// ── Read ────────────────────────────────────────────────────────────────────────

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Dhaka-day boundaries for "today" in follow-up filters. */
function dhakaDay(now = new Date()) {
  const start = Math.floor((now.getTime() + DHAKA_OFFSET) / DAY) * DAY - DHAKA_OFFSET;
  return { start: new Date(start), end: new Date(start + DAY) };
}

function filtersToQuery(orgId, user, f) {
  const q = { orgId, ...scopeFor(user) };
  if (f.type) q.type = f.type;
  if (f.stageId) q.stageId = oid(f.stageId);
  if (f.status) q.status = f.status;
  if (f.source) q.source = f.source;
  if (f.projectId) q['interest.projectId'] = oid(f.projectId);
  if (f.tag) q.tags = f.tag;
  if (f.assignee) {
    if (!canReadAll(user) && f.assignee !== 'me' && f.assignee !== user.id) {
      throw new ForbiddenError('You can only see your own leads');
    }
    if (f.assignee === 'unassigned') q.assigneeId = null;
    else q.assigneeId = oid(f.assignee === 'me' ? user.id : f.assignee);
  }
  if (f.from || f.to) {
    q.createdAt = {};
    if (f.from) q.createdAt.$gte = f.from;
    if (f.to) q.createdAt.$lt = f.to;
  }
  if (f.followUp) {
    const now = new Date();
    const { start, end } = dhakaDay(now);
    q.status = 'open';
    if (f.followUp === 'overdue') q.nextFollowUpAt = { $lt: now };
    else if (f.followUp === 'today') q.nextFollowUpAt = { $gte: start, $lt: end };
    else if (f.followUp === 'upcoming') q.nextFollowUpAt = { $gte: end };
    else q.nextFollowUpAt = null;
  }
  if (f.slaBreached !== undefined) {
    const now = new Date();
    const breached = {
      $or: [
        { firstResponseAt: null, status: 'open', slaDueAt: { $lt: now } },
        {
          $expr: {
            $and: [{ $ne: ['$slaDueAt', null] }, { $gt: ['$firstResponseAt', '$slaDueAt'] }],
          },
        },
      ],
    };
    if (f.slaBreached) q.$and = [...(q.$and ?? []), breached];
    else q.$and = [...(q.$and ?? []), { $nor: [breached] }];
  }
  if (f.q) {
    const digits = f.q
      .replace(/[^\d০-৯]/g, '')
      .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
    const or = [
      { name: { $regex: escapeRegex(f.q), $options: 'i' } },
      { email: f.q.toLowerCase() },
    ];
    if (digits.length >= 4) or.push({ phone: { $regex: escapeRegex(digits.replace(/^0/, '')) } });
    q.$and = [...(q.$and ?? []), { $or: or }];
  }
  return q;
}

export async function listLeads(orgId, user, query) {
  const { cursor, limit, ...filters } = query;
  const q = { ...filtersToQuery(orgId, user, filters), ...cursorFilter(cursor) };
  const rows = await Lead.find(q)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  const stages = await getStagesForLeads(orgId, items);
  return { items: await serializeLeads(orgId, items, { stages }), meta };
}

async function getStagesForLeads(orgId, leads) {
  const types = [...new Set(leads.map((l) => l.type))];
  return (await Promise.all(types.map((t) => getStages(orgId, t)))).flat();
}

export async function getLeadDetail(orgId, user, id) {
  const l = await getVisibleLead(orgId, user, id);
  const stages = await getStages(orgId, l.type);
  const [lead] = await serializeLeads(orgId, [l], { stages });
  return lead;
}

/** Cards of one column after (rank, id) — Kanban "load more". */
function columnFilter(base, stage, closedSince) {
  const q = { ...base, stageId: stage._id };
  if (stage.kind !== 'open') q.closedAt = { $gte: closedSince };
  return q;
}

/**
 * Kanban board: every stage with its total (under the same filters) and the first `perStage`
 * cards by rank. Won/lost columns show only the last `closedDays` days.
 */
export async function getBoard(orgId, user, query) {
  const { type, perStage, closedDays, ...filters } = query;
  const stages = await getStages(orgId, type);
  const base = filtersToQuery(orgId, user, { ...filters, type });
  const closedSince = new Date(Date.now() - closedDays * DAY);

  const columns = await Promise.all(
    stages.map(async (s) => {
      const q = columnFilter(base, s, closedSince);
      const [count, rows] = await Promise.all([
        Lead.countDocuments(q),
        Lead.find(q).sort({ rank: 1, _id: 1 }).limit(perStage).lean(),
      ]);
      return { stage: s, count, rows };
    }),
  );
  const all = columns.flatMap((c) => c.rows);
  const refs = await refsFor(orgId, all, { stages });
  const now = new Date();
  return {
    type,
    stages: columns.map((c) => ({
      ...toStage(c.stage, c.count),
      leads: c.rows.map((l) => toLead(l, refs, now)),
      hasMore: c.count > c.rows.length,
    })),
  };
}

export async function listStageCards(orgId, user, stageId, query) {
  const { afterRank, afterId, limit, closedDays, perStage: _p, type: _t, ...filters } = query;
  const stage = await getStage(orgId, stageId);
  const base = filtersToQuery(orgId, user, { ...filters, type: stage.pipeline });
  const q = columnFilter(base, stage, new Date(Date.now() - closedDays * DAY));
  if (afterRank) {
    q.$and = [
      ...(q.$and ?? []),
      {
        $or: [
          { rank: { $gt: afterRank } },
          ...(afterId ? [{ rank: afterRank, _id: { $gt: oid(afterId) } }] : []),
        ],
      },
    ];
  }
  const rows = await Lead.find(q)
    .sort({ rank: 1, _id: 1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: await serializeLeads(orgId, items, { stages: [stage] }),
    meta: { limit, hasMore },
  };
}

// ── Edit ────────────────────────────────────────────────────────────────────────

const EDITABLE = [
  'name',
  'phone',
  'altPhone',
  'email',
  'source',
  'sourceDetail',
  'interest',
  'land',
  'tags',
];

export async function updateLead({ orgId, user, id, patch }) {
  const doc = await Lead.findOne({ orgId, _id: id, ...scopeFor(user) });
  if (!doc) throw new NotFoundError('Lead not found');
  if (doc.__v !== patch.version) throw staleVersion();
  if (patch.land && doc.type !== 'landowner') {
    throw new BadRequestError('Land details are only for landowner leads', {
      code: 'FIELD_NOT_ALLOWED',
    });
  }

  const changes = {};
  if (patch.phone !== undefined) {
    changes.phone = phoneOrThrow(patch.phone);
    if (changes.phone !== doc.phone && doc.status === 'open')
      changes.openKey = openKeyOf(doc.type, changes.phone);
  }
  if (patch.altPhone !== undefined)
    changes.altPhone = patch.altPhone ? phoneOrThrow(patch.altPhone, 'altPhone') : null;
  if (patch.interest) {
    const interest = { ...(doc.toObject().interest ?? {}), ...patch.interest };
    for (const k of ['projectId', 'unitId']) if (interest[k]) interest[k] = String(interest[k]);
    await checkInterest(orgId, interest);
    changes.interest = interest;
  }
  if (patch.land) changes.land = { ...(doc.toObject().land ?? {}), ...landIn(patch.land) };
  for (const k of ['name', 'email', 'source', 'tags'])
    if (patch[k] !== undefined) changes[k] = patch[k];
  if (patch.sourceDetail)
    changes.sourceDetail = { ...(doc.toObject().sourceDetail ?? {}), ...patch.sourceDetail };

  const snapshot = () => {
    const o = doc.toObject();
    return Object.fromEntries(EDITABLE.map((k) => [k, JSON.stringify(o[k] ?? null)]));
  };
  const before = snapshot();
  doc.set(changes);
  const after = snapshot();
  const changed = EDITABLE.filter((k) => before[k] !== after[k]);
  try {
    await doc.save();
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.openKey) {
      throw new ConflictError('An open lead with this phone number already exists', {
        code: 'DUPLICATE_LEAD',
      });
    }
    throw err;
  }
  if (changed.length)
    await addActivity(orgId, doc._id, 'updated', {
      actorId: oid(user.id),
      meta: { fields: changed },
    });
  return getLeadDetail(orgId, user, id);
}

// ── Kanban move / stage change ──────────────────────────────────────────────────

/** Give cards that share `rank` in a column distinct ranks (oldest keeps it), in id order. */
async function separateTiedRanks(orgId, stageId, rank) {
  const tied = await Lead.find({ orgId, stageId, rank }).sort({ _id: 1 }).select('_id').lean();
  if (tied.length < 2) return;
  const next = await Lead.findOne({ orgId, stageId, rank: { $gt: rank } })
    .sort({ rank: 1 })
    .select('rank')
    .lean();
  let prev = rank;
  for (const t of tied.slice(1)) {
    const r = rankBetween(prev, next?.rank ?? null);
    await Lead.updateOne({ orgId, _id: t._id, rank }, { $set: { rank: r } });
    prev = r;
  }
}

/**
 * Move a card to `stageId`, between `afterId` (card above) and `beforeId` (card below).
 * The status follows the stage kind (open/won/lost); `lost` needs a reason. Reopening a closed
 * lead fails with 409 DUPLICATE_LEAD when the same phone already has another open lead.
 */
export async function moveLead({ orgId, user, id, move }) {
  const lead = await getVisibleLead(orgId, user, id);
  if (lead.__v !== move.version) throw staleVersion();
  const stage = await getStage(orgId, move.stageId);
  if (stage.pipeline !== lead.type) {
    throw new BadRequestError('That stage belongs to another pipeline', { code: 'UNKNOWN_STAGE' });
  }
  if (stage.kind === 'lost' && !move.lostReason) {
    throw new BadRequestError('Pick why the lead was lost', {
      code: 'LOST_REASON_REQUIRED',
      details: [{ path: 'lostReason', message: 'Required' }],
    });
  }

  // Neighbours must be in the target column; otherwise the client's board is stale.
  const ids = [move.afterId, move.beforeId].filter(Boolean).filter((x) => x !== id);
  const neighbours = ids.length
    ? await Lead.find({ orgId, _id: { $in: ids }, stageId: stage._id })
        .select('rank')
        .lean()
    : [];
  if (neighbours.length !== ids.length) {
    throw new ConflictError('The board changed — reload and try again', { code: 'STALE_POSITION' });
  }
  // Two leads created at the same instant can share a rank; split the tie, then re-read.
  if (neighbours.length === 2 && neighbours[0].rank === neighbours[1].rank) {
    await separateTiedRanks(orgId, stage._id, neighbours[0].rank);
    const fresh = await Lead.find({ orgId, _id: { $in: ids } })
      .select('rank')
      .lean();
    for (const n of neighbours) n.rank = fresh.find((f) => String(f._id) === String(n._id))?.rank;
  }
  const rankOf = (nid) =>
    (nid && nid !== id ? neighbours.find((n) => String(n._id) === nid)?.rank : null) ?? null;
  const above = rankOf(move.afterId);
  let below = rankOf(move.beforeId);
  if (!move.afterId && !move.beforeId)
    below =
      (
        await Lead.findOne({ orgId, stageId: stage._id, _id: { $ne: lead._id } })
          .sort({ rank: 1 })
          .select('rank')
          .lean()
      )?.rank ?? null;
  if (above !== null && below !== null && above >= below) {
    throw new ConflictError('The board changed — reload and try again', { code: 'STALE_POSITION' });
  }
  const rank = rankBetween(above, below);

  const now = new Date();
  const status = stage.kind;
  const set = { stageId: stage._id, rank, status };
  if (status === 'open')
    Object.assign(set, {
      closedAt: null,
      lostReason: null,
      lostNote: null,
      openKey: openKeyOf(lead.type, lead.phone),
    });
  else
    Object.assign(set, {
      closedAt: lead.status === status ? (lead.closedAt ?? now) : now,
      openKey: null,
    });
  if (status === 'lost')
    Object.assign(set, { lostReason: move.lostReason, lostNote: move.lostNote ?? null });
  if (status === 'won') Object.assign(set, { lostReason: null, lostNote: null });

  const stageChanged = String(lead.stageId) !== String(stage._id);
  // Moving a fresh lead forward counts as the first response.
  const stages = stageChanged ? await getStages(orgId, lead.type) : null;
  if (
    stageChanged &&
    !lead.firstResponseAt &&
    String(entryStage(stages)._id) === String(lead.stageId)
  ) {
    set.firstResponseAt = now;
  }
  if (stageChanged) set.lastActivityAt = now;

  let updated;
  try {
    updated = await Lead.findOneAndUpdate(
      { orgId, _id: lead._id, __v: move.version },
      { $set: set, $inc: { __v: 1 } },
      { returnDocument: 'after', lean: true },
    );
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.openKey) {
      throw new ConflictError(
        'Another open lead has this phone number — merge them instead of reopening',
        {
          code: 'DUPLICATE_LEAD',
        },
      );
    }
    throw err;
  }
  if (!updated) throw staleVersion();

  if (stageChanged) {
    await addActivity(orgId, lead._id, 'stage_change', {
      actorId: oid(user.id),
      body: status === 'lost' ? (move.lostNote ?? null) : null,
      meta: {
        from: String(lead.stageId),
        to: String(stage._id),
        status,
        lostReason: move.lostReason ?? null,
      },
    });
    if (status !== 'open') {
      await LeadTask.updateMany(
        { orgId, leadId: lead._id, status: 'open' },
        { $set: { status: 'cancelled' } },
      );
      await Lead.updateOne({ orgId, _id: lead._id }, { $set: { nextFollowUpAt: null } });
      updated.nextFollowUpAt = null;
    }
  }
  return (
    await serializeLeads(orgId, [updated], {
      stages: stages ?? (await getStages(orgId, lead.type)),
    })
  )[0];
}

/**
 * B4: a booking closes its lead as won (first `won` stage, top of the column), cancels open
 * follow-ups and writes a `booking` entry. Runs after the booking commits; a lead that was
 * merged/deleted meanwhile is skipped. Returns the lead id or null.
 */
export async function markLeadWon(orgId, leadId, { actorId, bookingId, bookingNo, unitCode }) {
  const lead = await Lead.findOne({ orgId, _id: leadId }).lean();
  if (!lead) return null;
  const now = new Date();
  const actor = actorId ? oid(actorId) : null;
  if (lead.status !== 'won') {
    const won = (await getStages(orgId, lead.type)).find((s) => s.kind === 'won');
    if (won) {
      const top = await Lead.findOne({ orgId, stageId: won._id })
        .sort({ rank: 1 })
        .select('rank')
        .lean();
      const set = {
        stageId: won._id,
        rank: rankBetween(null, top?.rank ?? null),
        status: 'won',
        closedAt: now,
        openKey: null,
        lostReason: null,
        lostNote: null,
        nextFollowUpAt: null,
        lastActivityAt: now,
        ...(!lead.firstResponseAt && { firstResponseAt: now }),
      };
      await Lead.updateOne({ orgId, _id: lead._id }, { $set: set, $inc: { __v: 1 } });
      await LeadTask.updateMany(
        { orgId, leadId: lead._id, status: 'open' },
        { $set: { status: 'cancelled' } },
      );
      await addActivity(orgId, lead._id, 'stage_change', {
        actorId: actor,
        meta: { from: String(lead.stageId), to: String(won._id), status: 'won', lostReason: null },
      });
    }
  }
  await addActivity(orgId, lead._id, 'booking', {
    actorId: actor,
    meta: { bookingId: String(bookingId), bookingNo, unitCode },
  });
  return String(lead._id);
}

// ── Assignment ──────────────────────────────────────────────────────────────────

async function applyAssignment(orgId, leads, assigneeId, { actor, ctx, bulk = false }) {
  const to = assigneeId ? oid(assigneeId) : null;
  const now = new Date();
  for (const l of leads) {
    if (String(l.assigneeId ?? '') === String(assigneeId ?? '')) continue;
    // Open follow-ups move with the lead.
    if (to) {
      await LeadTask.updateMany(
        { orgId, leadId: l._id, status: 'open', assigneeId: l.assigneeId },
        { $set: { assigneeId: to } },
      );
    }
    await addActivity(orgId, l._id, 'assigned', {
      actorId: oid(actor.id),
      meta: { from: idOrNull(l.assigneeId), to: idOrNull(to) },
    });
    if (to && String(to) !== actor.id) {
      await notify(orgId, [to], 'lead.assigned', {
        leadId: String(l._id),
        name: l.name,
        type: l.type,
        source: l.source,
        by: actor.name,
      });
    }
  }
  await audit(ctx, bulk ? 'lead.bulk_assign' : 'lead.assign', {
    entity: bulk ? undefined : { type: 'Lead', id: leads[0]._id },
    meta: {
      to: idOrNull(to),
      count: leads.length,
      ...(bulk && { ids: leads.map((l) => String(l._id)) }),
    },
  });
  return now;
}

export async function assignLead({ orgId, user, id, assigneeId, version, ctx }) {
  if (assigneeId) await checkAssignee(orgId, assigneeId);
  const lead = await Lead.findOne({ orgId, _id: id }).lean();
  if (!lead) throw new NotFoundError('Lead not found');
  if (lead.__v !== version) throw staleVersion();
  const now = new Date();
  const updated = await Lead.findOneAndUpdate(
    { orgId, _id: id, __v: version },
    {
      $set: {
        assigneeId: assigneeId ? oid(assigneeId) : null,
        assignedAt: assigneeId ? now : null,
      },
      $inc: { __v: 1 },
    },
    { returnDocument: 'after', lean: true },
  );
  if (!updated) throw staleVersion();
  await applyAssignment(orgId, [lead], assigneeId, { actor: user, ctx });
  return getLeadDetail(orgId, user, id);
}

/** Up to 200 leads to one person (or unassigned). Skips nothing silently: unknown ids → 404. */
export async function bulkAssign({ orgId, user, ids, assigneeId, ctx }) {
  if (assigneeId) await checkAssignee(orgId, assigneeId);
  const leads = await Lead.find({ orgId, _id: { $in: ids.map(oid) } }).lean();
  if (leads.length !== new Set(ids).size) throw new NotFoundError('Some leads were not found');
  await Lead.updateMany(
    { orgId, _id: { $in: leads.map((l) => l._id) } },
    {
      $set: {
        assigneeId: assigneeId ? oid(assigneeId) : null,
        assignedAt: assigneeId ? new Date() : null,
      },
      $inc: { __v: 1 },
    },
  );
  await applyAssignment(orgId, leads, assigneeId, { actor: user, ctx, bulk: true });
  return { updated: leads.length };
}

// ── Merge & delete ──────────────────────────────────────────────────────────────

/**
 * Merge `sourceId` into `targetId` (same type): timeline and tasks move over, enquiry counts
 * add up, empty fields are filled from the source, and the source is closed and hidden.
 */
export async function mergeLeads({ orgId, user, targetId, sourceId, ctx }) {
  if (targetId === sourceId)
    throw new BadRequestError('Pick two different leads', { code: 'SAME_LEAD' });
  const [target, source] = await Promise.all([
    Lead.findOne({ orgId, _id: targetId }).lean(),
    Lead.findOne({ orgId, _id: sourceId }).lean(),
  ]);
  if (!target || !source) throw new NotFoundError('Lead not found');
  if (target.type !== source.type) {
    throw new BadRequestError("Buyer and landowner leads can't be merged", {
      code: 'TYPE_MISMATCH',
    });
  }

  const fill = {};
  for (const k of ['email', 'altPhone', 'message'])
    if (!target[k] && source[k]) fill[k] = source[k];
  if (!target.altPhone && source.phone !== target.phone) fill.altPhone = source.phone;
  if (!target.interest?.projectId && source.interest?.projectId)
    fill['interest.projectId'] = source.interest.projectId;
  if (!target.interest?.unitId && source.interest?.unitId)
    fill['interest.unitId'] = source.interest.unitId;
  const firstResponse =
    [target.firstResponseAt, source.firstResponseAt].filter(Boolean).sort((a, b) => a - b)[0] ??
    null;
  const tags = [...new Set([...(target.tags ?? []), ...(source.tags ?? [])])].slice(0, 20);

  await withTransaction(async (session) => {
    await LeadActivity.updateMany(
      { orgId, leadId: source._id },
      { $set: { leadId: target._id } },
    ).session(session);
    await LeadTask.updateMany(
      { orgId, leadId: source._id },
      { $set: { leadId: target._id } },
    ).session(session);
    await Lead.updateOne(
      { orgId, _id: source._id },
      {
        $set: {
          mergedIntoId: target._id,
          openKey: null,
          deletedAt: new Date(),
          deletedBy: oid(user.id),
        },
        $inc: { __v: 1 },
      },
    ).session(session);
    await Lead.updateOne(
      { orgId, _id: target._id },
      {
        $set: {
          ...fill,
          tags,
          firstResponseAt: firstResponse,
          lastEnquiryAt:
            [target.lastEnquiryAt, source.lastEnquiryAt].filter(Boolean).sort((a, b) => b - a)[0] ??
            null,
        },
        $inc: { enquiryCount: source.enquiryCount ?? 1, __v: 1 },
      },
    ).session(session);
    await addActivity(orgId, target._id, 'merged', {
      actorId: oid(user.id),
      meta: { sourceId: String(source._id), sourceName: source.name, sourcePhone: source.phone },
      session,
    });
    await audit(ctx, 'lead.merge', {
      entity: { type: 'Lead', id: target._id },
      meta: { sourceId: String(source._id) },
      session,
    });
  });
  await refreshNextFollowUp(orgId, target._id);
  return getLeadDetail(orgId, user, targetId);
}

export async function deleteLead({ orgId, user, id, ctx }) {
  const doc = await Lead.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Lead not found');
  doc.openKey = null;
  await doc.softDelete(oid(user.id));
  await LeadTask.updateMany(
    { orgId, leadId: doc._id, status: 'open' },
    { $set: { status: 'cancelled' } },
  );
  await audit(ctx, 'lead.delete', {
    entity: { type: 'Lead', id: doc._id },
    meta: { name: doc.name, phone: doc.phone },
  });
}

// ── SLA escalation (B3.2) ───────────────────────────────────────────────────────

const ESCALATE_LOOKBACK_MS = 7 * DAY; // older misses are history, not alerts (first deploy, long outage)

/**
 * Job `leads.slaEscalation` (every minute): an open lead whose first-response time passed with no
 * response → every active manager (`leads:assign`) gets one `lead.sla_breached` notification and
 * the timeline notes it. Once per lead: the lead is claimed atomically via `slaEscalatedAt`.
 */
export async function escalateSlaBreaches(orgId, { now = new Date(), batch = 200 } = {}) {
  const due = await Lead.find({
    orgId,
    status: 'open',
    firstResponseAt: null,
    slaEscalatedAt: null,
    slaDueAt: { $lte: now, $gte: new Date(now.getTime() - ESCALATE_LOOKBACK_MS) },
  })
    .sort({ slaDueAt: 1 })
    .limit(batch)
    .select('name type source assigneeId slaDueAt')
    .lean();
  if (!due.length) return { escalated: 0 };

  const managers = await managersOf(orgId);
  const names = await userNames(
    orgId,
    due.map((l) => l.assigneeId),
  );
  let escalated = 0;
  for (const l of due) {
    const claimed = await Lead.updateOne(
      { orgId, _id: l._id, status: 'open', firstResponseAt: null, slaEscalatedAt: null },
      { $set: { slaEscalatedAt: now } },
    );
    if (!claimed.modifiedCount) continue; // answered or claimed by another run meanwhile
    await addActivity(orgId, l._id, 'sla_escalated', {
      meta: { dueAt: l.slaDueAt, notified: managers.length },
    });
    await notify(orgId, managers, 'lead.sla_breached', {
      leadId: String(l._id),
      name: l.name,
      type: l.type,
      source: l.source,
      assigneeId: idOrNull(l.assigneeId),
      assigneeName: l.assigneeId ? (names.get(String(l.assigneeId)) ?? null) : null,
      slaDueAt: l.slaDueAt,
    });
    escalated += 1;
  }
  if (escalated) log.info({ escalated }, 'SLA breaches escalated');
  return { escalated };
}

/** Keep `nextFollowUpAt` = the earliest open task's due time. */
export async function refreshNextFollowUp(orgId, leadId) {
  const next = await LeadTask.findOne({ orgId, leadId, status: 'open' })
    .sort({ dueAt: 1 })
    .select('dueAt')
    .lean();
  await Lead.updateOne({ orgId, _id: leadId }, { $set: { nextFollowUpAt: next?.dueAt ?? null } });
}

/** A staff contact (call, SMS, visit…) — first response + last activity. */
export async function touchLead(orgId, leadId, { at, contact }) {
  const set = { lastActivityAt: at };
  await Lead.updateOne({ orgId, _id: leadId }, { $max: set });
  if (contact) {
    await Lead.updateOne(
      { orgId, _id: leadId, firstResponseAt: null },
      { $set: { firstResponseAt: at } },
    );
  }
}

// ── Export ──────────────────────────────────────────────────────────────────────

const MAX_EXPORT = 10_000;

/** Spreadsheet formula injection guard: a cell starting with = + - @ is text, not a formula. */
const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV (UTF-8 with BOM so Excel shows Bangla), newest first, at most 10,000 rows. */
export async function exportLeadsCsv(orgId, user, filters, ctx) {
  const q = filtersToQuery(orgId, user, filters);
  const rows = await Lead.find(q).sort({ createdAt: -1, _id: -1 }).limit(MAX_EXPORT).lean();
  const stages = await getStagesForLeads(orgId, rows);
  const refs = await refsFor(orgId, rows, { stages });
  const header = [
    'Created',
    'Name',
    'Phone',
    'Alt phone',
    'Email',
    'Type',
    'Source',
    'Campaign',
    'Stage',
    'Status',
    'Lost reason',
    'Assigned to',
    'Project',
    'Unit',
    'Budget from (BDT)',
    'Budget to (BDT)',
    'Enquiries',
    'First response',
    'Next follow-up',
    'Tags',
    'Message',
  ];
  const fmt = (d) =>
    d
      ? new Date(new Date(d).getTime() + DHAKA_OFFSET).toISOString().slice(0, 16).replace('T', ' ')
      : '';
  const taka = (p) => (p == null ? '' : Math.round(p / 100));
  const lines = rows.map((l) => {
    const x = toLead(l, refs);
    return [
      fmt(x.createdAt),
      x.name,
      x.phone,
      x.altPhone,
      x.email,
      x.type,
      x.source,
      x.sourceDetail.campaign,
      x.stage?.name,
      x.status,
      x.lostReason,
      x.assigneeName,
      x.interest.project?.name,
      x.interest.unitCode,
      taka(x.interest.budgetMin),
      taka(x.interest.budgetMax),
      x.enquiryCount,
      fmt(x.firstResponseAt),
      fmt(x.nextFollowUpAt),
      x.tags.join('; '),
      x.message,
    ]
      .map(csvCell)
      .join(',');
  });
  await audit(ctx, 'lead.export', {
    meta: { rows: rows.length, filters: JSON.parse(JSON.stringify(filters)) },
  });
  log.info({ rows: rows.length }, 'Leads exported');
  return `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
