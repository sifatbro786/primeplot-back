import mongoose from 'mongoose';
import { addDays, daysBetween, toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { offsetMeta } from '#shared/utils/pagination.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { remainingOf, scheduleTotals } from '#modules/accounts/allocation.js';
import * as customers from '#modules/customers/customer.service.js';
import { projectSummaries } from '#modules/projects/project.service.js';
import { Booking } from './booking.model.js';

/**
 * Reports (B4.2, reports:read). Dues are computed from the schedules in memory: one company
 * has hundreds to a few thousand active bookings, which is a single indexed read.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

const BUCKETS = [
  ['d1_30', 1, 30],
  ['d31_60', 31, 60],
  ['d61_90', 61, 90],
  ['d90_plus', 91, Infinity],
];
const emptyBuckets = () => Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));

/** Overdue amount per age bucket (days past the due date). */
export function agingOf(schedule, asOf) {
  const out = emptyBuckets();
  let oldest = null;
  for (const i of schedule) {
    const rem = remainingOf(i);
    if (!rem || !i.dueDate) continue;
    const due = toDhakaDate(i.dueDate);
    const days = daysBetween(due, asOf);
    if (days < 1) continue;
    const [key] = BUCKETS.find(([, lo, hi]) => days >= lo && days <= hi);
    out[key] += rem;
    if (!oldest || due < oldest) oldest = due;
  }
  return { buckets: out, oldestDueDate: oldest };
}

/** GET /reports/dues — who owes what, oldest first in each bucket. */
export async function duesReport(orgId, q) {
  const asOf = q.asOf ?? todayDhaka();
  const filter = { orgId, status: 'active' };
  if (q.projectId) filter.projectId = oid(q.projectId);
  if (q.soldBy) filter.soldBy = oid(q.soldBy);
  const rows = await Booking.find(filter)
    .select(
      'bookingNo projectId unitCode customerId customerName soldBy soldByName stage schedule price.contractTotal',
    )
    .lean();

  const totals = { outstanding: 0, dueNow: 0, overdue: 0, buckets: emptyBuckets(), bookings: 0 };
  const list = [];
  for (const b of rows) {
    const t = scheduleTotals(b.schedule, asOf);
    if (!t.outstanding) continue;
    if (q.overdueOnly === 'true' && !t.overdue) continue;
    const { buckets, oldestDueDate } = agingOf(b.schedule, asOf);
    totals.outstanding += t.outstanding;
    totals.dueNow += t.dueNow;
    totals.overdue += t.overdue;
    for (const k of Object.keys(buckets)) totals.buckets[k] += buckets[k];
    totals.bookings += 1;
    list.push({ b, t, buckets, oldestDueDate });
  }
  list.sort((x, y) => y.t.overdue - x.t.overdue || x.b.bookingNo.localeCompare(y.b.bookingNo));
  const page = list.slice((q.page - 1) * q.limit, q.page * q.limit);

  const [projects, people] = await Promise.all([
    projectSummaries(
      orgId,
      page.map((r) => r.b.projectId),
    ),
    customers.customersByIds(
      orgId,
      page.map((r) => r.b.customerId),
    ),
  ]);
  return {
    asOf,
    totals,
    items: page.map(({ b, t, buckets, oldestDueDate }) => ({
      bookingId: String(b._id),
      bookingNo: b.bookingNo,
      project: projects.get(String(b.projectId)) ?? { id: String(b.projectId) },
      unitCode: b.unitCode,
      stage: b.stage ?? 'booked',
      customer: {
        id: String(b.customerId),
        name: b.customerName,
        phone: people.get(String(b.customerId))?.phone ?? null,
      },
      soldBy: { id: String(b.soldBy), name: b.soldByName ?? null },
      contractTotal: b.price.contractTotal,
      outstanding: t.outstanding,
      dueNow: t.dueNow,
      overdue: t.overdue,
      buckets,
      oldestDueDate,
      nextDue: t.nextDue && { ...t.nextDue, dueDate: toDhakaDate(t.nextDue.dueDate) },
    })),
    meta: offsetMeta(q, list.length),
  };
}

/** GET /reports/collections — default: this calendar month (Dhaka). */
export async function collectionsReport(orgId, q) {
  const today = todayDhaka();
  const from = q.from ?? `${today.slice(0, 8)}01`;
  const to = q.to ?? today;
  const summary = await accounts.collectionSummary(orgId, { ...q, from, to });
  const projects = await projectSummaries(
    orgId,
    summary.byProject.map((p) => p.projectId),
  );
  return {
    from,
    to,
    interval: q.interval,
    ...summary,
    byProject: summary.byProject.map((p) => ({
      ...p,
      project: projects.get(p.projectId) ?? { id: p.projectId },
    })),
  };
}

/** GET /reports/pdcs — cheques to bank in the window (default next 30 days) + bounced ones. */
export async function pdcReport(orgId, q) {
  const today = todayDhaka();
  const from = q.from ?? addDays(today, -365); // includes overdue, not yet deposited
  const to = q.to ?? addDays(today, 30);
  const rows = await accounts.chequesForReport(orgId, { projectId: q.projectId, from, to });
  const items = await accounts.serializeCheques(orgId, rows);
  const sum = (list) => list.reduce((s, c) => s + c.amount, 0);
  const due = items.filter((c) => c.status !== 'bounced' && c.chequeDate <= today);
  const upcoming = items.filter((c) => c.status !== 'bounced' && c.chequeDate > today);
  const bounced = items.filter((c) => c.status === 'bounced');
  return {
    from,
    to,
    today,
    totals: {
      dueNow: { count: due.length, amount: sum(due) },
      upcoming: { count: upcoming.length, amount: sum(upcoming) },
      bounced: { count: bounced.length, amount: sum(bounced) },
    },
    dueNow: due,
    upcoming,
    bounced,
  };
}
