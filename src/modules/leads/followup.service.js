import mongoose from 'mongoose';
import { P } from '#shared/auth/permissions.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#shared/errors/AppError.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { notify } from '#modules/notifications/notification.service.js';
import { listActiveStaffWith, userNames } from '#modules/users/user.service.js';
import { Lead } from './lead.model.js';
import { CONTACT_TYPES, LeadActivity } from './leadActivity.model.js';
import { LeadTask } from './leadTask.model.js';
import {
  canAssign,
  canReadAll,
  getVisibleLead,
  refreshNextFollowUp,
  touchLead,
} from './lead.service.js';

/**
 * Lead timeline (activities) and follow-up tasks (B3).
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const idOrNull = (v) => (v ? String(v) : null);
const DAY = 86_400_000;
const DHAKA_OFFSET = 6 * 3_600_000;
const MAX_BACKDATE = 30 * DAY;

const staleVersion = () =>
  new ConflictError('This task was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

// ── Activities ──────────────────────────────────────────────────────────────────

function toActivity(a, names) {
  return {
    id: String(a._id),
    leadId: String(a.leadId),
    type: a.type,
    body: a.body ?? null,
    outcome: a.outcome ?? null,
    durationSec: a.durationSec ?? null,
    at: a.at,
    actorId: idOrNull(a.actorId),
    actorName: a.actorId ? (names.get(String(a.actorId)) ?? null) : null,
    meta: a.meta ?? null,
    createdAt: a.createdAt,
  };
}

export async function listActivities(orgId, user, leadId, { cursor, limit }) {
  await getVisibleLead(orgId, user, leadId);
  const rows = await LeadActivity.find({ orgId, leadId, ...cursorFilter(cursor) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  // Names for actors and for user ids inside meta (assignment from/to).
  const ids = items.flatMap((a) =>
    [a.actorId, a.meta?.from, a.meta?.to].filter((x) => x && ObjectId.isValid(String(x))),
  );
  const names = await userNames(orgId, ids);
  return {
    items: items.map((a) => {
      const out = toActivity(a, names);
      if (a.type === 'assigned' && out.meta) {
        out.meta = {
          ...out.meta,
          fromName: names.get(String(a.meta.from)) ?? null,
          toName: names.get(String(a.meta.to)) ?? null,
        };
      }
      return out;
    }),
    meta,
  };
}

/** Log a call / note / visit… Any contact type also sets the first-response time. */
export async function logActivity({ orgId, user, leadId, input }) {
  const lead = await getVisibleLead(orgId, user, leadId);
  const now = new Date();
  const at = input.at ?? now;
  if (at > new Date(now.getTime() + 5 * 60_000) || at < new Date(now.getTime() - MAX_BACKDATE)) {
    throw new BadRequestError('The time must be within the last 30 days', {
      code: 'INVALID_TIME',
      details: [{ path: 'at', message: 'Within the last 30 days' }],
    });
  }
  if (input.outcome && input.type !== 'call') {
    throw new BadRequestError('Outcome is only for calls', { code: 'FIELD_NOT_ALLOWED' });
  }
  const doc = await LeadActivity.create({
    orgId,
    leadId: lead._id,
    type: input.type,
    body: input.body ?? null,
    outcome: input.outcome ?? null,
    durationSec: input.durationSec ?? null,
    at,
    actorId: oid(user.id),
  });
  await touchLead(orgId, lead._id, { at, contact: CONTACT_TYPES.includes(input.type) });
  return toActivity(doc.toObject(), new Map([[user.id, user.name]]));
}

// ── Tasks ───────────────────────────────────────────────────────────────────────

function toTask(t, refs = {}) {
  return {
    id: String(t._id),
    version: t.__v ?? 0,
    leadId: String(t.leadId),
    leadName: refs.leads?.get(String(t.leadId))?.name ?? null,
    leadPhone: refs.leads?.get(String(t.leadId))?.phone ?? null,
    assigneeId: String(t.assigneeId),
    assigneeName: refs.names?.get(String(t.assigneeId)) ?? null,
    title: t.title,
    type: t.type,
    dueAt: t.dueAt,
    remindAt: t.remindAt ?? null,
    status: t.status,
    doneAt: t.doneAt ?? null,
    createdAt: t.createdAt,
  };
}

async function taskRefs(orgId, tasks) {
  const leadIds = [...new Set(tasks.map((t) => String(t.leadId)))];
  const [leads, names] = await Promise.all([
    Lead.find({ orgId, _id: { $in: leadIds } })
      .select('name phone')
      .setOptions({ withDeleted: true })
      .lean(),
    userNames(
      orgId,
      tasks.map((t) => t.assigneeId),
    ),
  ]);
  return { leads: new Map(leads.map((l) => [String(l._id), l])), names };
}

const remindAtOf = (dueAt, minutes) =>
  minutes == null ? null : new Date(dueAt.getTime() - minutes * 60_000);

/** Task owner: the lead's owner by default; someone else needs leads:assign. */
async function resolveTaskAssignee(orgId, user, lead, assigneeId) {
  const target = assigneeId ?? idOrNull(lead.assigneeId) ?? user.id;
  if (target !== user.id && target !== idOrNull(lead.assigneeId) && !canAssign(user)) {
    throw new ForbiddenError('Only managers can give tasks to others');
  }
  if (target !== user.id) {
    const [u] = await listActiveStaffWith(orgId, P.LEADS_READ_OWN, { ids: [target] });
    if (!u) throw new BadRequestError('Pick an active sales user', { code: 'INVALID_ASSIGNEE' });
  }
  return oid(target);
}

export async function createTask({ orgId, user, leadId, input }) {
  const lead = await getVisibleLead(orgId, user, leadId);
  if (lead.status !== 'open') {
    throw new ConflictError('This lead is closed — reopen it to plan a follow-up', {
      code: 'LEAD_CLOSED',
    });
  }
  const assigneeId = await resolveTaskAssignee(orgId, user, lead, input.assigneeId);
  const task = await LeadTask.create({
    orgId,
    leadId: lead._id,
    assigneeId,
    title: input.title,
    type: input.type,
    dueAt: input.dueAt,
    remindAt: remindAtOf(input.dueAt, input.remindMinutesBefore),
    createdBy: oid(user.id),
  });
  await LeadActivity.create({
    orgId,
    leadId: lead._id,
    type: 'task_created',
    body: input.title,
    actorId: oid(user.id),
    meta: { taskId: String(task._id), dueAt: input.dueAt },
  });
  await refreshNextFollowUp(orgId, lead._id);
  return toTask(task.toObject(), await taskRefs(orgId, [task]));
}

/** Who may change a task: its owner, or anyone who sees all leads. */
async function loadTaskFor(orgId, user, taskId) {
  const task = await LeadTask.findOne({ orgId, _id: taskId });
  if (!task) throw new NotFoundError('Task not found');
  if (!canReadAll(user) && String(task.assigneeId) !== user.id)
    throw new NotFoundError('Task not found');
  return task;
}

export async function updateTask({ orgId, user, taskId, patch }) {
  const task = await loadTaskFor(orgId, user, taskId);
  if (task.__v !== patch.version) throw staleVersion();
  const lead = await Lead.findOne({ orgId, _id: task.leadId }).lean();
  if (!lead) throw new NotFoundError('Task not found');

  if (patch.assigneeId && patch.assigneeId !== String(task.assigneeId)) {
    task.assigneeId = await resolveTaskAssignee(orgId, user, lead, patch.assigneeId);
    task.remindedAt = null;
  }
  for (const k of ['title', 'type']) if (patch[k] !== undefined) task[k] = patch[k];
  if (patch.dueAt) task.dueAt = patch.dueAt;
  if (patch.dueAt || patch.remindMinutesBefore !== undefined) {
    const minutes =
      patch.remindMinutesBefore !== undefined
        ? patch.remindMinutesBefore
        : task.remindAt
          ? Math.round((task.dueAt.getTime() - task.remindAt.getTime()) / 60_000)
          : null;
    task.remindAt = remindAtOf(task.dueAt, minutes);
    task.remindedAt = null; // rescheduled → remind again
  }

  const completing = patch.status === 'done' && task.status !== 'done';
  if (patch.status) {
    if (patch.status === 'open' && lead.status !== 'open') {
      throw new ConflictError('This lead is closed', { code: 'LEAD_CLOSED' });
    }
    task.status = patch.status;
    task.doneAt = patch.status === 'done' ? new Date() : null;
    task.doneBy = patch.status === 'done' ? oid(user.id) : null;
  }
  await task.save();

  if (completing) {
    await LeadActivity.create({
      orgId,
      leadId: task.leadId,
      type: 'task_done',
      body: task.title,
      actorId: oid(user.id),
      meta: { taskId: String(task._id) },
    });
    await touchLead(orgId, task.leadId, { at: new Date(), contact: false });
  }
  await refreshNextFollowUp(orgId, task.leadId);
  return toTask(task.toObject(), await taskRefs(orgId, [task]));
}

function dhakaDay(now) {
  const start = Math.floor((now.getTime() + DHAKA_OFFSET) / DAY) * DAY - DHAKA_OFFSET;
  return { start: new Date(start), end: new Date(start + DAY) };
}

/**
 * Task lists: "mine" (default) or "all" (needs leads:read_all), by due window. Sorted by due
 * time; the cursor is the last row's (dueAt, id).
 */
export async function listTasks(orgId, user, query) {
  const { scope, due, status, leadId, assigneeId, cursor, limit } = query;
  if (scope === 'all' && !canReadAll(user))
    throw new ForbiddenError('You can only see your own tasks');
  const q = { orgId, status };
  if (scope === 'mine') q.assigneeId = oid(user.id);
  else if (assigneeId) q.assigneeId = oid(assigneeId);
  if (leadId) {
    // A lead's own task list: everyone who can see the lead sees all of its tasks.
    await getVisibleLead(orgId, user, leadId);
    q.leadId = oid(leadId);
    delete q.assigneeId;
  }
  const now = new Date();
  const { start, end } = dhakaDay(now);
  if (due === 'overdue') q.dueAt = { $lt: now };
  else if (due === 'today') q.dueAt = { $gte: start, $lt: end };
  else if (due === 'upcoming') q.dueAt = { $gte: end };

  if (cursor) {
    let c;
    try {
      const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      c = { dueAt: new Date(ts), _id: oid(id) };
    } catch {
      throw new BadRequestError('Invalid cursor', { code: 'INVALID_CURSOR' });
    }
    q.$and = [{ $or: [{ dueAt: { $gt: c.dueAt } }, { dueAt: c.dueAt, _id: { $gt: c._id } }] }];
  }
  const rows = await LeadTask.find(q)
    .sort({ dueAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const refs = await taskRefs(orgId, items);
  const last = items.at(-1);
  return {
    items: items.map((t) => toTask(t, refs)),
    meta: {
      limit,
      nextCursor: hasMore
        ? Buffer.from(JSON.stringify([last.dueAt.getTime(), String(last._id)])).toString(
            'base64url',
          )
        : null,
    },
  };
}

/** Counts for the dashboard badge: my overdue / today. */
export async function taskCounts(orgId, user) {
  const now = new Date();
  const { end } = dhakaDay(now);
  const base = { orgId, assigneeId: oid(user.id), status: 'open' };
  const [overdue, today] = await Promise.all([
    LeadTask.countDocuments({ ...base, dueAt: { $lt: now } }),
    LeadTask.countDocuments({ ...base, dueAt: { $gte: now, $lt: end } }),
  ]);
  return { overdue, today };
}

/**
 * Reminder sweep (job `leads.taskReminders`, every minute): notify the owner of every open task
 * whose reminder time has passed, once. Claimed with an atomic update so a retried or doubled
 * run never notifies twice.
 */
export async function sendDueReminders(orgId, { now = new Date(), batch = 200 } = {}) {
  const due = await LeadTask.find({
    orgId,
    status: 'open',
    remindedAt: null,
    remindAt: { $lte: now },
  })
    .sort({ remindAt: 1 })
    .limit(batch)
    .lean();
  let sent = 0;
  for (const t of due) {
    const claimed = await LeadTask.updateOne(
      { orgId, _id: t._id, remindedAt: null, status: 'open' },
      { $set: { remindedAt: now } },
    );
    if (!claimed.modifiedCount) continue;
    const lead = await Lead.findOne({ orgId, _id: t.leadId }).select('name phone').lean();
    if (!lead) continue; // lead deleted meanwhile
    await notify(orgId, [t.assigneeId], 'task.due', {
      taskId: String(t._id),
      leadId: String(t.leadId),
      title: t.title,
      dueAt: t.dueAt,
      leadName: lead.name,
      leadPhone: lead.phone,
    });
    sent += 1;
  }
  return { sent };
}
