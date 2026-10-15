import mongoose from 'mongoose';
import { addMonths, parseDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { scheduleTotals } from '#modules/accounts/allocation.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { agingOf } from '#modules/bookings/report.service.js';
import { Lead } from '#modules/leads/lead.model.js';
import { LeadStage } from '#modules/leads/leadStage.model.js';
import { OnlinePayment } from '#modules/payments/onlinePayment.model.js';
import { PaymentSlip } from '#modules/portal/paymentSlip.model.js';
import { projectSummaries } from '#modules/projects/project.service.js';
import { Unit } from '#modules/units/unit.model.js';
import { User } from '#modules/users/user.model.js';

/**
 * Basic analytics (B5.3, v1 scope: ARCHITECTURE §4 "Basic analytics"). Aggregations only —
 * charts are drawn by the dashboard (F6). Every money figure is integer poisha; periods are
 * Dhaka calendar months. Default range: the last 12 months including this one.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const TZ = 'Asia/Dhaka';

export function defaultRange(q = {}) {
  const today = todayDhaka();
  const to = q.to ?? today;
  const from = q.from ?? `${addMonths(`${to.slice(0, 7)}-01`, -11)}`;
  return { from, to };
}

const dateRange = ({ from, to }) => ({
  $gte: parseDhakaDate(from),
  $lt: new Date(parseDhakaDate(to).getTime() + 86_400_000),
});

/** Months between two dates, 'YYYY-MM', inclusive — so empty months still show as 0. */
export function monthsBetween(from, to) {
  const out = [];
  let m = `${from.slice(0, 7)}-01`;
  while (m.slice(0, 7) <= to.slice(0, 7)) {
    out.push(m.slice(0, 7));
    m = addMonths(m, 1);
  }
  return out;
}

const fill = (months, rows, empty) => {
  const by = new Map(rows.map((r) => [r.period, r]));
  return months.map((period) => ({ period, ...empty, ...by.get(period) }));
};

// ── Inventory ───────────────────────────────────────────────────────────────────

export async function inventory(orgId, { projectId } = {}) {
  const now = new Date();
  const match = { orgId: oid(orgId), ...(projectId && { projectId: oid(projectId) }) };
  const rows = await Unit.aggregate([
    { $match: match },
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
        units: { $sum: 1 },
        listValue: { $sum: { $ifNull: ['$listPrice', 0] } },
      },
    },
  ]);
  const projects = await projectSummaries(
    orgId,
    rows.map((r) => r._id.p),
  );
  const byProject = new Map();
  const total = { units: 0, byStatus: {} };
  for (const r of rows) {
    const k = String(r._id.p);
    if (!byProject.has(k)) {
      byProject.set(k, {
        project: projects.get(k) ?? { id: k },
        units: 0,
        byStatus: {},
        availableValue: 0,
      });
    }
    const p = byProject.get(k);
    p.units += r.units;
    p.byStatus[r._id.s] = r.units;
    if (r._id.s === 'available') p.availableValue = r.listValue;
    total.units += r.units;
    total.byStatus[r._id.s] = (total.byStatus[r._id.s] ?? 0) + r.units;
  }
  const sold = ['booked', 'allotted', 'registered', 'handed_over'];
  const soldOf = (bs) => sold.reduce((s, k) => s + (bs[k] ?? 0), 0);
  const list = [...byProject.values()].map((p) => ({
    ...p,
    sold: soldOf(p.byStatus),
    soldPct: p.units ? Math.round((soldOf(p.byStatus) / p.units) * 1000) / 10 : 0,
  }));
  list.sort((a, b) => b.units - a.units);
  return { ...total, sold: soldOf(total.byStatus), projects: list };
}

// ── Sales ───────────────────────────────────────────────────────────────────────

export async function sales(orgId, q = {}) {
  const range = defaultRange(q);
  const match = {
    orgId: oid(orgId),
    bookingDate: dateRange(range),
    ...(q.projectId && { projectId: oid(q.projectId) }),
  };
  const [facet] = await Booking.aggregate([
    { $match: match },
    {
      $facet: {
        byMonth: [
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$bookingDate', timezone: TZ } },
              bookings: { $sum: 1 },
              value: { $sum: '$price.contractTotal' },
              discount: { $sum: { $ifNull: ['$price.discount.amount', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ],
        bySeller: [
          {
            $group: {
              _id: '$soldBy',
              name: { $last: '$soldByName' },
              bookings: { $sum: 1 },
              value: { $sum: '$price.contractTotal' },
            },
          },
          { $sort: { value: -1 } },
          { $limit: 10 },
        ],
        byProject: [
          {
            $group: {
              _id: '$projectId',
              bookings: { $sum: 1 },
              value: { $sum: '$price.contractTotal' },
            },
          },
          { $sort: { value: -1 } },
        ],
        cancelled: [{ $match: { status: 'cancelled' } }, { $count: 'n' }],
      },
    },
  ]);
  const months = monthsBetween(range.from, range.to);
  const projects = await projectSummaries(
    orgId,
    facet.byProject.map((p) => p._id),
  );
  const byMonth = fill(
    months,
    facet.byMonth.map((m) => ({
      period: m._id,
      bookings: m.bookings,
      value: m.value,
      discount: m.discount,
    })),
    { bookings: 0, value: 0, discount: 0 },
  );
  return {
    ...range,
    totals: {
      bookings: byMonth.reduce((s, m) => s + m.bookings, 0),
      value: byMonth.reduce((s, m) => s + m.value, 0),
      discount: byMonth.reduce((s, m) => s + m.discount, 0),
      cancelled: facet.cancelled[0]?.n ?? 0,
    },
    byMonth,
    bySeller: facet.bySeller.map((s) => ({
      id: String(s._id),
      name: s.name ?? null,
      bookings: s.bookings,
      value: s.value,
    })),
    byProject: facet.byProject.map((p) => ({
      project: projects.get(String(p._id)) ?? { id: String(p._id) },
      bookings: p.bookings,
      value: p.value,
    })),
  };
}

// ── Collections & dues ──────────────────────────────────────────────────────────

export async function collections(orgId, q = {}) {
  const range = defaultRange(q);
  const summary = await accounts.collectionSummary(orgId, {
    ...range,
    projectId: q.projectId,
    interval: 'month',
  });
  const months = monthsBetween(range.from, range.to);
  // Dues today across active bookings (same maths as the dues report).
  const asOf = todayDhaka();
  const rows = await Booking.find({
    orgId,
    status: 'active',
    ...(q.projectId && { projectId: oid(q.projectId) }),
  })
    .select('schedule')
    .lean();
  const dues = { outstanding: 0, dueNow: 0, overdue: 0, bookingsOverdue: 0, buckets: {} };
  for (const b of rows) {
    const t = scheduleTotals(b.schedule, asOf);
    dues.outstanding += t.outstanding;
    dues.dueNow += t.dueNow;
    dues.overdue += t.overdue;
    if (t.overdue) dues.bookingsOverdue += 1;
    const { buckets } = agingOf(b.schedule, asOf);
    for (const [k, v] of Object.entries(buckets)) dues.buckets[k] = (dues.buckets[k] ?? 0) + v;
  }
  // Expected in the next 3 months (scheduled, unpaid) — the collection forecast staff plan by.
  const horizon = monthsBetween(asOf, addMonths(asOf, 2));
  const upcoming = new Map(horizon.map((m) => [m, 0]));
  for (const b of rows) {
    for (const i of b.schedule) {
      const rem = Math.max(0, i.amount - (i.paid ?? 0));
      if (!rem || !i.dueDate) continue;
      const m = new Date(new Date(i.dueDate).getTime() + 6 * 3_600_000).toISOString().slice(0, 7);
      if (upcoming.has(m) && new Date(i.dueDate) >= parseDhakaDate(asOf))
        upcoming.set(m, upcoming.get(m) + rem);
    }
  }
  return {
    ...range,
    collected: summary.total,
    refunds: summary.refunds,
    byMonth: fill(
      months,
      summary.byPeriod.map((p) => ({ period: p.period, count: p.count, amount: p.amount })),
      { count: 0, amount: 0 },
    ),
    byMode: summary.byMode,
    dues: { asOf, ...dues },
    expected: [...upcoming].map(([period, amount]) => ({ period, amount })),
  };
}

// ── CRM pipeline ────────────────────────────────────────────────────────────────

export async function pipeline(orgId, q = {}) {
  const range = defaultRange(q);
  const created = dateRange(range);
  const [stages, open, sources, closed, byMonth] = await Promise.all([
    LeadStage.find({ orgId, pipeline: 'buyer' }).sort({ order: 1 }).lean(),
    Lead.aggregate([
      { $match: { orgId: oid(orgId), type: 'buyer', status: 'open', mergedIntoId: null } },
      { $group: { _id: '$stageId', n: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { orgId: oid(orgId), type: 'buyer', createdAt: created, mergedIntoId: null } },
      { $group: { _id: '$source', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]),
    Lead.aggregate([
      {
        $match: {
          orgId: oid(orgId),
          type: 'buyer',
          status: { $in: ['won', 'lost'] },
          closedAt: created,
          mergedIntoId: null,
        },
      },
      { $group: { _id: { status: '$status', reason: '$lostReason' }, n: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { orgId: oid(orgId), type: 'buyer', createdAt: created, mergedIntoId: null } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: TZ } },
          n: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const openBy = new Map(open.map((r) => [String(r._id), r.n]));
  const won = closed.filter((r) => r._id.status === 'won').reduce((s, r) => s + r.n, 0);
  const lost = closed.filter((r) => r._id.status === 'lost').reduce((s, r) => s + r.n, 0);
  const lostReasons = closed
    .filter((r) => r._id.status === 'lost')
    .map((r) => ({ reason: r._id.reason ?? null, count: r.n }))
    .sort((a, b) => b.count - a.count);
  return {
    ...range,
    stages: stages
      .filter((s) => s.kind === 'open')
      .map((s) => ({
        id: String(s._id),
        key: s.key,
        name: s.name,
        nameBn: s.nameBn ?? null,
        count: openBy.get(String(s._id)) ?? 0,
      })),
    openTotal: open.reduce((s, r) => s + r.n, 0),
    newBySource: sources.map((r) => ({ source: r._id, count: r.n })),
    newTotal: sources.reduce((s, r) => s + r.n, 0),
    won,
    lost,
    winRatePct: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
    lostReasons,
    byMonth: fill(
      monthsBetween(range.from, range.to),
      byMonth.map((m) => ({ period: m._id, leads: m.n, won: m.won })),
      { leads: 0, won: 0 },
    ),
  };
}

// ── Portal (B5) ─────────────────────────────────────────────────────────────────

export async function portal(orgId, q = {}) {
  const range = defaultRange(q);
  const [clients, slips, online] = await Promise.all([
    User.aggregate([
      { $match: { orgId: oid(orgId), role: 'client' } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    PaymentSlip.aggregate([
      { $match: { orgId: oid(orgId), createdAt: dateRange(range) } },
      { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    OnlinePayment.aggregate([
      { $match: { orgId: oid(orgId), createdAt: dateRange(range) } },
      { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);
  const obj = (rows, withAmount) =>
    Object.fromEntries(
      rows.map((r) => [r._id, withAmount ? { count: r.n, amount: r.amount } : r.n]),
    );
  return {
    ...range,
    clients: obj(clients),
    slips: obj(slips, true),
    onlinePayments: obj(online, true),
  };
}

export async function overview(orgId, q = {}) {
  const [inv, sal, col, pipe, por] = await Promise.all([
    inventory(orgId, q),
    sales(orgId, q),
    collections(orgId, q),
    pipeline(orgId, q),
    portal(orgId, q),
  ]);
  return {
    ...defaultRange(q),
    inventory: inv,
    sales: sal,
    collections: col,
    pipeline: pipe,
    portal: por,
  };
}
