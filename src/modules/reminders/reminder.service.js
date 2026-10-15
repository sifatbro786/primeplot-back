import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { toBdMsisdn } from '#integrations/sms/index.js';
import { queueEmail } from '#integrations/email/queue.js';
import { ConflictError } from '#shared/errors/AppError.js';
import {
  addDays,
  daysBetween,
  parseDhakaDate,
  toDhakaDate,
  todayDhaka,
} from '#shared/utils/dhakaDate.js';
import { formatTaka } from '#shared/utils/money.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { audit } from '#modules/audit/audit.service.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { remainingOf, scheduleTotals } from '#modules/accounts/allocation.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { Customer } from '#modules/customers/customer.model.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { portalUrl } from '#modules/portal/portalAccount.service.js';
import { projectSummaries } from '#modules/projects/project.service.js';
import { queueSms } from '#modules/sms/sms.service.js';
import { ReminderLog } from './reminderLog.model.js';

/**
 * Installment reminder engine (B5.3, ARCHITECTURE §3.6). Rules are day offsets from the due date
 * (default −7, 0, +3, +15 — accounts settings `reminders`). Once a day, after `sendHour` Dhaka
 * time, the `reminders.run` job finds unpaid schedule items whose due date makes a rule fire and
 * sends ONE message per (booking, rule, due date) — several items due the same day are summed.
 *
 * Catch-up: a rule still fires up to GRACE_DAYS late (server down, sendHour moved) but never
 * once the next rule's day is reached. The delivery log's unique index makes every run
 * idempotent. Paid, cancelled, not-yet-called (no due date) items never get a reminder.
 */
const log = logger.child({ module: 'reminders' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

export const GRACE_DAYS = 2;
const DHAKA_OFFSET_MS = 6 * 3_600_000;
export const dhakaHour = (now = new Date()) =>
  new Date(now.getTime() + DHAKA_OFFSET_MS).getUTCHours();

/** Windows in "days since due" for each enabled rule: [from, to] inclusive. */
export function ruleWindows(rules) {
  const on = rules.filter((r) => r.enabled).sort((a, b) => a.offsetDays - b.offsetDays);
  return on.map((r, i) => {
    const next = on[i + 1];
    const to = Math.min(r.offsetDays + GRACE_DAYS, next ? next.offsetDays - 1 : Infinity);
    return { ...r, from: r.offsetDays, to };
  });
}

export const kindOf = (daysSinceDue) =>
  daysSinceDue < 0 ? 'upcoming' : daysSinceDue === 0 ? 'today' : 'overdue';

/**
 * Pure planner: which reminders are due `today` for these bookings (lean, with schedule).
 * Returns [{ booking, rule, dueDate ('YYYY-MM-DD'), kind, items: [{ itemId, label, amount }],
 *           amount, totalOverdue }].
 */
export function planReminders(bookings, rules, today) {
  const windows = ruleWindows(rules);
  if (!windows.length) return [];
  const out = [];
  for (const b of bookings) {
    if (b.status !== 'active') continue;
    const groups = new Map(); // dueDate → items
    for (const i of b.schedule ?? []) {
      const rem = remainingOf(i);
      if (!rem || !i.dueDate) continue;
      const due = toDhakaDate(i.dueDate);
      if (!groups.has(due)) groups.set(due, []);
      groups.get(due).push({
        itemId: i._id,
        label: i.label,
        labelBn: i.labelBn ?? null,
        dueDate: due,
        amount: rem,
      });
    }
    if (!groups.size) continue;
    const { overdue } = scheduleTotals(b.schedule, today);
    for (const [due, items] of groups) {
      const d = daysBetween(due, today);
      const rule = windows.find((w) => d >= w.from && d <= w.to);
      if (!rule) continue;
      out.push({
        booking: b,
        rule,
        dueDate: due,
        kind: kindOf(d),
        items,
        amount: items.reduce((s, x) => s + x.amount, 0),
        totalOverdue: overdue,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) || a.booking.bookingNo.localeCompare(b.booking.bookingNo),
  );
  return out;
}

// ── Texts ───────────────────────────────────────────────────────────────────────

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnNum = (s) => String(s).replace(/\d/g, (d) => BN_DIGITS[d]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function displayDate(ymd, locale) {
  const [y, m, d] = ymd.split('-');
  return locale === 'en' ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : bnNum(`${d}/${m}/${y}`);
}

const tk = (p) => formatTaka(p, { decimals: p % 100 !== 0 });

export const REMINDER_SMS = {
  bn: {
    upcoming: (v) =>
      `${v.company}: প্রিয় ${v.name}, ${v.unit}-এর ৳${bnNum(v.amount)} কিস্তি ${v.date} তারিখে পরিশোধযোগ্য। বিস্তারিত: ${v.url}`,
    today: (v) =>
      `${v.company}: প্রিয় ${v.name}, ${v.unit}-এর ৳${bnNum(v.amount)} কিস্তির শেষ তারিখ আজ (${v.date})। বিস্তারিত: ${v.url}`,
    overdue: (v) =>
      `${v.company}: প্রিয় ${v.name}, ${v.unit}-এর ৳${bnNum(v.amount)} কিস্তি ${v.date} থেকে বকেয়া। দ্রুত পরিশোধ করুন; দিয়ে থাকলে উপেক্ষা করুন। ${v.url}`,
  },
  en: {
    upcoming: (v) =>
      `${v.company}: Dear ${v.name}, Tk ${v.amount} for ${v.unit} is due on ${v.date}. Details: ${v.url}`,
    today: (v) =>
      `${v.company}: Dear ${v.name}, Tk ${v.amount} for ${v.unit} is due today (${v.date}). Details: ${v.url}`,
    overdue: (v) =>
      `${v.company}: Dear ${v.name}, Tk ${v.amount} for ${v.unit} has been overdue since ${v.date}. Please pay soon; ignore if paid. ${v.url}`,
  },
};

// ── Sending ─────────────────────────────────────────────────────────────────────

async function deliver({ org, plan, customer, project, by = null, displayDue = null }) {
  const orgId = org._id;
  const b = plan.booking;
  const locale = (customer.locale ?? org.settings?.defaultLocale ?? 'bn') === 'en' ? 'en' : 'bn';
  const ruleSms = plan.rule.sms ?? true;
  const ruleEmail = plan.rule.email ?? true;
  const sms = !ruleSms
    ? { status: 'off', reason: 'rule_off' }
    : !toBdMsisdn(customer.phone)
      ? { status: 'skipped', reason: 'not_bd_mobile' }
      : { status: 'queued' };
  const email = !ruleEmail
    ? { status: 'off', reason: 'rule_off' }
    : !customer.email
      ? { status: 'skipped', reason: 'no_email' }
      : { status: 'queued' };

  // Claim first: the unique index decides who sends (two overlapping runs → one message).
  let logDoc;
  try {
    logDoc = await ReminderLog.create({
      orgId,
      bookingId: b._id,
      bookingNo: b.bookingNo,
      projectId: b.projectId,
      unitCode: b.unitCode,
      customerId: customer._id,
      customerName: customer.name,
      ruleKey: plan.rule.key,
      offsetDays: plan.rule.offsetDays ?? null,
      kind: plan.kind,
      dueDate: parseDhakaDate(plan.dueDate),
      runDate: todayDhaka(),
      amount: plan.amount,
      totalOverdue: plan.totalOverdue,
      items: plan.items.map((i) => ({ itemId: i.itemId, label: i.label, amount: i.amount })),
      locale,
      sms,
      email,
      by: by ? oid(by.id) : null,
      byName: by?.name ?? null,
    });
  } catch (err) {
    if (err?.code === 11000) return null; // already sent
    throw err;
  }

  const company = (locale === 'bn' && org.nameBn) || org.name;
  const name = ((locale === 'bn' && customer.nameBn) || customer.name).split(' ')[0];
  const unit = `${b.unitCode}${project ? `, ${(locale === 'bn' && project.nameBn) || project.name}` : ''}`;
  const date = displayDate(displayDue ?? plan.dueDate, locale);
  const url = portalUrl(locale, `/bookings/${b._id}`);
  const set = {};
  if (sms.status === 'queued') {
    try {
      const msg = await queueSms({
        orgId,
        to: customer.phone,
        text: REMINDER_SMS[locale][plan.kind]({
          company,
          name,
          unit,
          amount: tk(plan.amount),
          date,
          url,
        }),
        purpose: 'reminder',
        locale,
        bookingId: b._id,
        customerId: customer._id,
        createdBy: by?.id ?? null,
        expiresInMs: 12 * 3_600_000, // a reminder a day late is noise
      });
      set['sms.smsId'] = oid(msg.id);
    } catch (err) {
      set.sms = { status: 'skipped', reason: (err.code ?? 'error').slice(0, 60) };
    }
  }
  if (email.status === 'queued') {
    try {
      await queueEmail({
        orgId,
        to: customer.email,
        template: 'installment_reminder',
        locale,
        data: {
          orgName: company,
          name: (locale === 'bn' && customer.nameBn) || customer.name,
          kind: plan.kind,
          bookingNo: b.bookingNo,
          unit: b.unitCode,
          project: project ? (locale === 'bn' && project.nameBn) || project.name : '',
          amount: tk(plan.amount),
          dueDate: date,
          items: plan.items.map((i) => ({
            label: (locale === 'bn' && i.labelBn) || i.label,
            amount: tk(i.amount),
            dueDate: displayDate(i.dueDate ?? plan.dueDate, locale),
          })),
          totalOverdue: plan.totalOverdue > plan.amount ? tk(plan.totalOverdue) : null,
          url,
        },
      });
    } catch (err) {
      set.email = { status: 'skipped', reason: (err.code ?? 'error').slice(0, 60) };
    }
  }
  if (Object.keys(set).length)
    await ReminderLog.updateOne({ orgId, _id: logDoc._id }, { $set: set });
  return logDoc;
}

async function loadCandidates(orgId, rules, today, { bookingId } = {}) {
  const windows = ruleWindows(rules);
  if (!windows.length) return [];
  const maxTo = Math.max(
    ...windows.map((w) => (Number.isFinite(w.to) ? w.to : w.from + GRACE_DAYS)),
  );
  const minFrom = Math.min(...windows.map((w) => w.from));
  // dueDate = today − daysSinceDue → [today − maxTo, today − minFrom]
  const range = {
    $gte: parseDhakaDate(addDays(today, -maxTo)),
    $lte: parseDhakaDate(addDays(today, -minFrom)),
  };
  return Booking.find({
    orgId,
    status: 'active',
    ...(bookingId && { _id: oid(bookingId) }),
    'schedule.dueDate': range,
  })
    .select('bookingNo projectId unitCode customerId status schedule')
    .lean();
}

/**
 * The daily run (job `reminders.run`, every 30 min — it only acts after sendHour, and the log
 * keeps it to once a day). `force` ignores the hour (staff "run now"); `dryRun` sends nothing
 * and returns what would go.
 */
export async function runReminders(
  orgId,
  { now = new Date(), force = false, dryRun = false } = {},
) {
  const settings = accounts.reminderSettingsOf(await accounts.getAccountSettings(orgId));
  if (!settings.enabled && !dryRun) return { skipped: 'disabled' };
  if (!force && !dryRun && dhakaHour(now) < settings.sendHour)
    return { skipped: 'before_send_hour' };
  const today = todayDhaka(now);
  const bookings = await loadCandidates(orgId, settings.rules, today);
  const plans = planReminders(bookings, settings.rules, today);
  if (!plans.length) return { today, planned: 0, sent: 0, alreadySent: 0 };

  const [people, projects, sentKeys] = await Promise.all([
    Customer.find({
      orgId,
      _id: { $in: [...new Set(plans.map((p) => String(p.booking.customerId)))] },
    })
      .setOptions({ withDeleted: true })
      .lean()
      .then((rows) => new Map(rows.map((c) => [String(c._id), c]))),
    projectSummaries(
      orgId,
      plans.map((p) => p.booking.projectId),
    ),
    ReminderLog.find({ orgId, bookingId: { $in: plans.map((p) => p.booking._id) } })
      .select('bookingId ruleKey dueDate')
      .lean()
      .then(
        (rows) => new Set(rows.map((r) => `${r.bookingId}|${r.ruleKey}|${toDhakaDate(r.dueDate)}`)),
      ),
  ]);
  const key = (p) => `${p.booking._id}|${p.rule.key}|${p.dueDate}`;
  const fresh = plans.filter((p) => !sentKeys.has(key(p)));

  if (dryRun) {
    return {
      today,
      planned: plans.length,
      alreadySent: plans.length - fresh.length,
      items: fresh.map((p) => {
        const c = people.get(String(p.booking.customerId));
        return {
          bookingId: String(p.booking._id),
          bookingNo: p.booking.bookingNo,
          unitCode: p.booking.unitCode,
          customer: c
            ? { id: String(c._id), name: c.name, phone: c.phone, email: c.email ?? null }
            : null,
          rule: p.rule.key,
          kind: p.kind,
          dueDate: p.dueDate,
          amount: p.amount,
          channels: {
            sms: Boolean(p.rule.sms && c && toBdMsisdn(c.phone)),
            email: Boolean(p.rule.email && c?.email),
          },
        };
      }),
    };
  }

  const org = await Organization.findOne({ _id: orgId }).lean();
  let sent = 0;
  for (const p of fresh) {
    const customer = people.get(String(p.booking.customerId));
    if (!customer) continue;
    try {
      if (
        await deliver({
          org,
          plan: p,
          customer,
          project: projects.get(String(p.booking.projectId)),
        })
      )
        sent += 1;
    } catch (err) {
      log.error(
        { bookingNo: p.booking.bookingNo, err: { message: err.message } },
        'reminder failed',
      );
    }
  }
  if (sent) log.info({ sent, today }, 'Installment reminders queued');
  return { today, planned: plans.length, sent, alreadySent: plans.length - fresh.length };
}

/**
 * Staff "remind now" for one booking: everything due today or overdue (or, if nothing is,
 * the next installment). Once per booking per day.
 */
export async function remindNow({ org, user, booking, ctx }) {
  const orgId = org._id;
  if (booking.status !== 'active') {
    throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
  }
  const today = todayDhaka();
  const unpaid = (booking.schedule ?? []).filter((i) => remainingOf(i) && i.dueDate);
  const dueNow = unpaid.filter((i) => toDhakaDate(i.dueDate) <= today);
  const next = unpaid
    .filter((i) => toDhakaDate(i.dueDate) > today)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
  const items = dueNow.length ? dueNow : next ? [next] : [];
  if (!items.length) {
    throw new ConflictError('Nothing is due on this booking', { code: 'NOTHING_DUE' });
  }
  const oldest = items.map((i) => toDhakaDate(i.dueDate)).sort()[0];
  const customer = await Customer.findOne({ orgId, _id: booking.customerId }).lean();
  const project = (await projectSummaries(orgId, [booking.projectId])).get(
    String(booking.projectId),
  );
  const plan = {
    booking,
    rule: { key: 'manual', offsetDays: null, sms: true, email: true },
    dueDate: today, // the per-day key; the message shows the oldest due date below
    kind: kindOf(daysBetween(oldest, today)),
    items: items.map((i) => ({
      itemId: i._id,
      label: i.label,
      labelBn: i.labelBn ?? null,
      dueDate: toDhakaDate(i.dueDate),
      amount: remainingOf(i),
    })),
    amount: items.reduce((s, i) => s + remainingOf(i), 0),
    totalOverdue: scheduleTotals(booking.schedule, today).overdue,
  };
  const doc = await deliver({ org, plan, customer, project, by: user, displayDue: oldest });
  if (!doc) {
    throw new ConflictError('A reminder was already sent for this booking today', {
      code: 'ALREADY_REMINDED_TODAY',
    });
  }
  await audit(ctx, 'reminder.manual', {
    entity: { type: 'Booking', id: booking._id },
    meta: { bookingNo: booking.bookingNo, amount: plan.amount, kind: plan.kind },
  });
  return toReminderLog(await ReminderLog.findOne({ orgId, _id: doc._id }).lean());
}

// ── Log ─────────────────────────────────────────────────────────────────────────

export function toReminderLog(r) {
  const ch = (c) => ({
    status: c?.status ?? 'off',
    reason: c?.reason ?? null,
    smsId: c?.smsId ? String(c.smsId) : null,
  });
  return {
    id: String(r._id),
    bookingId: String(r.bookingId),
    bookingNo: r.bookingNo,
    unitCode: r.unitCode,
    customer: { id: String(r.customerId), name: r.customerName },
    rule: r.ruleKey,
    offsetDays: r.offsetDays ?? null,
    kind: r.kind,
    dueDate: toDhakaDate(r.dueDate),
    runDate: r.runDate,
    amount: r.amount,
    totalOverdue: r.totalOverdue ?? 0,
    items: (r.items ?? []).map((i) => ({
      itemId: String(i.itemId),
      label: i.label ?? null,
      amount: i.amount,
    })),
    locale: r.locale,
    sms: ch(r.sms),
    email: ch(r.email),
    by: r.by ? { id: String(r.by), name: r.byName ?? null } : null,
    createdAt: r.createdAt,
  };
}

export async function listReminderLog(orgId, { bookingId, rule, from, to, cursor, limit }) {
  const filter = { orgId, ...cursorFilter(cursor) };
  if (bookingId) filter.bookingId = oid(bookingId);
  if (rule) filter.ruleKey = rule;
  if (from || to) filter.runDate = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const rows = await ReminderLog.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toReminderLog), meta };
}
