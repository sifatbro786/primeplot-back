import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#shared/errors/AppError.js';
import { withTransaction } from '#shared/db/withTransaction.js';
import { bpsOf } from '#shared/utils/money.js';
import { daysBetween, parseDhakaDate, toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { offsetMeta } from '#shared/utils/pagination.js';
import { normalizePhone } from '#shared/utils/phone.js';
import { audit } from '#modules/audit/audit.service.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { allocate, itemStatus, remainingOf, scheduleTotals } from '#modules/accounts/allocation.js';
import { ensureCounter, nextSeq } from '#modules/accounts/counter.model.js';
import * as customers from '#modules/customers/customer.service.js';
import { getVisibleLead, markLeadWon } from '#modules/leads/lead.service.js';
import { getProject, projectSummaries } from '#modules/projects/project.service.js';
import {
  announceUnitChanges,
  getUnitForSale,
  priceForSale,
  transitionUnit,
} from '#modules/units/unit.service.js';
import { effectiveStatus } from '#modules/units/unitStatus.js';
import { voidDocuments } from '#modules/documents/document.service.js';
import { Booking } from './booking.model.js';
import * as docs from './documentData.js';
import { planForBooking } from './plan.service.js';
import { customSchedule, generateSchedule, ScheduleError } from './schedule.js';

/**
 * Bookings & receipts (B4.1). Every money write runs in ONE MongoDB transaction:
 *   booking   = unit → booked + booking no. + price snapshot + schedule + booking-money receipt
 *   receipt   = receipt no. + allocation (oldest first) + ledger entry + schedule cache
 *   reversal  = negative ledger entry + reversal stamp + schedule cache
 * Side effects (socket, website revalidation, CRM lead → won, SMS) run after the commit.
 *
 * Visibility: without bookings:read_all a user sees only the bookings they sold (404 otherwise).
 */
const log = logger.child({ module: 'bookings' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const idOrNull = (v) => (v ? String(v) : null);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const staleVersion = () =>
  new ConflictError('This booking was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

export const unprocessable = (message, code, details) =>
  new AppError(message, { statusCode: 422, code, details });

export const canReadAllBookings = (user) => user.permissions.has(P.BOOKINGS_READ_ALL);
export const bookingScope = (user) => (canReadAllBookings(user) ? {} : { soldBy: oid(user.id) });

// ── Serialization ───────────────────────────────────────────────────────────────

export function toScheduleItem(i, asOf) {
  return {
    id: String(i._id),
    seq: i.seq,
    code: i.code,
    label: i.label,
    labelBn: i.labelBn ?? null,
    dueDate: i.dueDate ? toDhakaDate(i.dueDate) : null,
    amount: i.amount,
    paid: i.paid ?? 0,
    remaining: remainingOf(i),
    status: itemStatus(i, asOf),
    milestoneKey: i.milestoneKey ?? null,
    chargeKind: i.chargeKind ?? null,
    note: i.note ?? null,
  };
}

const act = (a) =>
  a
    ? {
        date: toDhakaDate(a.date),
        by: a.by ? { id: String(a.by), name: a.byName ?? null } : null,
        note: a.note ?? null,
      }
    : null;

function toBookingSummary(b, { projects, asOf }) {
  const totals = scheduleTotals(b.schedule, asOf);
  return {
    id: String(b._id),
    bookingNo: b.bookingNo,
    project: projects?.get(String(b.projectId)) ?? { id: String(b.projectId) },
    unitId: String(b.unitId),
    unitCode: b.unitCode,
    kind: b.kind,
    customerId: String(b.customerId),
    customerName: b.customerName,
    soldBy: { id: String(b.soldBy), name: b.soldByName ?? null },
    bookingDate: toDhakaDate(b.bookingDate),
    contractTotal: b.price.contractTotal,
    totals: {
      ...totals,
      nextDue: totals.nextDue && {
        ...totals.nextDue,
        dueDate: toDhakaDate(totals.nextDue.dueDate),
      },
    },
    status: b.status,
    stage: b.stage ?? 'booked',
    version: b.__v ?? 0,
    createdAt: b.createdAt,
  };
}

function toBooking(b, { projects, customerMap, receipts, cheques, asOf }) {
  const ref = (id) => {
    const c = customerMap.get(String(id));
    return c ? customers.toCustomerRef(c) : { id: String(id) };
  };
  return {
    ...toBookingSummary(b, { projects, asOf }),
    blockId: String(b.blockId),
    customer: ref(b.customerId),
    coApplicants: (b.coApplicantIds ?? []).map(ref),
    nominees: b.nominees ?? [],
    leadId: idOrNull(b.leadId),
    price: {
      strategy: b.price.strategy ?? null,
      rateUnit: b.price.rateUnit ?? null,
      lines: b.price.lines,
      listTotal: b.price.listTotal,
      baseAmount: b.price.baseAmount,
      discount: {
        amount: b.price.discount?.amount ?? 0,
        reason: b.price.discount?.reason ?? null,
      },
      contractTotal: b.price.contractTotal,
    },
    plan: {
      id: idOrNull(b.plan?.planId),
      name: b.plan?.name ?? null,
      custom: !b.plan?.spec,
    },
    schedule: b.schedule.map((i) => toScheduleItem(i, asOf)),
    bookingMoneyWaived: b.bookingMoneyWaived
      ? {
          reason: b.bookingMoneyWaived.reason,
          by: { id: idOrNull(b.bookingMoneyWaived.by), name: b.bookingMoneyWaived.byName ?? null },
        }
      : null,
    note: b.note ?? null,
    allotment: act(b.allotment),
    registration: b.registration
      ? {
          ...act(b.registration),
          deedNo: b.registration.deedNo,
          subRegistryOffice: b.registration.subRegistryOffice ?? null,
        }
      : null,
    handover: act(b.handover),
    holders: (b.holders ?? []).map((h) => ({
      id: String(h._id),
      customerId: String(h.customerId),
      customerName: h.customerName ?? null,
      until: toDhakaDate(h.until),
      toCustomerId: String(h.toCustomerId),
      fee: h.fee ?? 0,
      feeWaivedReason: h.feeWaivedReason ?? null,
      by: h.by ? { id: String(h.by), name: h.byName ?? null } : null,
      note: h.note ?? null,
    })),
    cancellation: b.cancellation
      ? {
          ...act(b.cancellation),
          reason: b.cancellation.reason,
          paid: b.cancellation.paid,
          deductionBps: b.cancellation.deductionBps ?? null,
          deduction: b.cancellation.deduction,
          refundable: b.cancellation.refundable,
          refunded: b.cancellation.refunded ?? 0,
          refundDue: b.cancellation.refundable - (b.cancellation.refunded ?? 0),
          overrideReason: b.cancellation.overrideReason ?? null,
        }
      : null,
    cheques: cheques ?? [],
    receipts: receipts ?? [],
  };
}

// ── Lookups ─────────────────────────────────────────────────────────────────────

export async function getVisibleBooking(orgId, user, id) {
  const b = await Booking.findOne({ orgId, _id: id, ...bookingScope(user) }).lean();
  if (!b) throw new NotFoundError('Booking not found');
  return b;
}

export async function getBookingDetail(orgId, user, id) {
  const b = await getVisibleBooking(orgId, user, id);
  const [projects, customerMap, receiptRows, chequeRows] = await Promise.all([
    projectSummaries(orgId, [b.projectId]),
    customers.customersByIds(orgId, [b.customerId, ...(b.coApplicantIds ?? [])]),
    accounts.receiptsOfBooking(orgId, b._id),
    accounts.chequesOfBooking(orgId, b._id),
  ]);
  return toBooking(b, {
    projects,
    customerMap,
    receipts: await accounts.serializeReceipts(orgId, receiptRows),
    cheques: await accounts.serializeCheques(orgId, chequeRows),
    asOf: todayDhaka(),
  });
}

export async function listBookings(orgId, user, q) {
  const filter = { orgId, ...bookingScope(user) };
  if (q.projectId) filter.projectId = oid(q.projectId);
  if (q.status) filter.status = q.status;
  if (q.soldBy && canReadAllBookings(user)) filter.soldBy = oid(q.soldBy);
  if (q.customerId) {
    filter.$or = [{ customerId: oid(q.customerId) }, { coApplicantIds: oid(q.customerId) }];
  }
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: 'i' };
    filter.$and = [
      {
        $or: [
          { bookingNo: { $regex: `^${escapeRegex(q.q.toUpperCase())}` } },
          { unitCode: rx },
          { customerName: rx },
        ],
      },
    ];
  }
  if (q.from || q.to) {
    filter.bookingDate = {
      ...(q.from && { $gte: parseDhakaDate(q.from) }),
      ...(q.to && { $lte: parseDhakaDate(q.to) }),
    };
  }
  const [rows, total] = await Promise.all([
    Booking.find(filter)
      .select('-price.lines -nominees')
      .sort({ bookingDate: -1, createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    Booking.countDocuments(filter),
  ]);
  const projects = await projectSummaries(
    orgId,
    rows.map((b) => b.projectId),
  );
  const asOf = todayDhaka();
  return {
    items: rows.map((b) => toBookingSummary(b, { projects, asOf })),
    meta: offsetMeta(q, total),
  };
}

// ── Quote (preview + create share it) ───────────────────────────────────────────

export function checkBusinessDate(date, today, backdateDays, prefix) {
  if (date > today) {
    throw unprocessable('The date cannot be in the future', `${prefix}_DATE_IN_FUTURE`, [
      { path: prefix === 'BOOKING' ? 'bookingDate' : 'date', message: 'In the future' },
    ]);
  }
  if (daysBetween(date, today) > backdateDays) {
    throw unprocessable(
      `The date can be at most ${backdateDays} days back`,
      `${prefix}_DATE_TOO_OLD`,
      [
        {
          path: prefix === 'BOOKING' ? 'bookingDate' : 'date',
          message: `Max ${backdateDays} days back`,
        },
      ],
    );
  }
}

export const scheduleFail = (err) =>
  err instanceof ScheduleError ? unprocessable(err.message, err.code, err.details) : err;

/**
 * Price + discount + schedule for a unit, without writing anything.
 * Throws 403 DISCOUNT_LIMIT above the user's cap, 422 PRICE_NOT_SET / INVALID_DISCOUNT / plan errors.
 */
async function quote(orgId, user, input, settings) {
  const today = todayDhaka();
  const bookingDate = input.bookingDate ?? today;
  checkBusinessDate(bookingDate, today, settings.receiptBackdateDays ?? 31, 'BOOKING');

  const unit = await getUnitForSale(orgId, input.unitId);
  const project = await getProject(orgId, unit.projectId);
  const breakdown = priceForSale(unit, project.pricing);
  if (!breakdown?.total) {
    throw unprocessable('This unit has no price yet — set the rate card first', 'PRICE_NOT_SET');
  }
  const baseAmount = breakdown.lines.find((l) => l.code === 'base')?.amount ?? 0;
  const capBps = accounts.discountCapBps(settings, user);
  const capAmount = capBps === null ? null : bpsOf(baseAmount, capBps);
  const discount = input.discount?.amount ?? 0;
  if (capAmount !== null && discount > capAmount) {
    throw new ForbiddenError('This discount is above your limit', {
      code: 'DISCOUNT_LIMIT',
      details: { capBps, maxAmount: capAmount },
    });
  }
  if (discount >= breakdown.total) {
    throw unprocessable('The discount cannot be the whole price', 'INVALID_DISCOUNT', [
      { path: 'discount.amount', message: 'Too large' },
    ]);
  }
  const contract = breakdown.total - discount;

  let items;
  let plan = null;
  try {
    if (input.schedule) {
      if (!user.permissions.has(P.BOOKINGS_OVERRIDE)) {
        throw new ForbiddenError('Only a manager can make a custom schedule', {
          code: 'CUSTOM_SCHEDULE_NOT_ALLOWED',
        });
      }
      items = customSchedule({ contract, items: input.schedule, bookingDate });
    } else {
      plan = await planForBooking(orgId, input.planId, project._id);
      items = generateSchedule({ contract, plan: plan.spec, bookingDate });
    }
  } catch (err) {
    throw scheduleFail(err);
  }
  return {
    unit,
    project,
    breakdown,
    baseAmount,
    capBps,
    capAmount,
    discount,
    contract,
    bookingDate,
    items,
    plan,
  };
}

/** POST /bookings/preview — what the wizard shows before saving. */
export async function previewBooking({ orgId, user, input }) {
  const settings = await accounts.getAccountSettings(orgId);
  const q = await quote(orgId, user, input, settings);
  const status = effectiveStatus(q.unit);
  const warnings = [];
  if (!q.project.code) warnings.push('PROJECT_CODE_REQUIRED');
  if (status === 'held' && String(q.unit.hold?.by) !== user.id) warnings.push('UNIT_HELD_BY_OTHER');
  if (!['available', 'held'].includes(status)) warnings.push('UNIT_NOT_AVAILABLE');
  const bookingMoney = q.items.find((i) => i.code === 'booking_money')?.amount ?? 0;
  return {
    unit: { id: String(q.unit._id), code: q.unit.code, kind: q.unit.kind, status },
    project: { id: String(q.project._id), name: q.project.name, code: q.project.code ?? null },
    price: {
      strategy: q.breakdown.strategy,
      rateUnit: q.breakdown.rateUnit ?? null,
      lines: q.breakdown.lines,
      listTotal: q.breakdown.total,
      baseAmount: q.baseAmount,
      discount: q.discount,
      contractTotal: q.contract,
    },
    discountCap: { bps: q.capBps, maxAmount: q.capAmount },
    bookingDate: q.bookingDate,
    plan: q.plan ? { id: String(q.plan._id), name: q.plan.name } : null,
    schedule: q.items.map((i) => ({ ...i, milestoneKey: i.milestoneKey ?? null })),
    bookingMoney,
    bookingMoneyRequired: settings.bookingMoneyRequired ?? true,
    warnings,
  };
}

// ── Money helpers ───────────────────────────────────────────────────────────────

export function allocateOrThrow(schedule, amount) {
  try {
    return allocate(schedule, amount);
  } catch (err) {
    if (err.message === 'OVERPAYMENT') {
      throw unprocessable('This is more than the outstanding balance', 'OVERPAYMENT', {
        outstanding: err.outstanding,
      });
    }
    throw err;
  }
}

/**
 * Apply allocations (sign +1 receipt, −1 reversal) to the booking's schedule cache, guarded by
 * the version read in this transaction. The cache must stay within 0…amount per item.
 */
export async function applyPaid(orgId, booking, allocations, sign, session) {
  const delta = new Map();
  for (const a of allocations) {
    const k = String(a.itemId);
    delta.set(k, (delta.get(k) ?? 0) + sign * a.amount);
  }
  let total = 0;
  const schedule = booking.schedule.map((i) => {
    const d = delta.get(String(i._id)) ?? 0;
    delta.delete(String(i._id));
    const paid = (i.paid ?? 0) + d;
    if (paid < 0 || paid > i.amount) {
      throw new AppError('Schedule cache out of range', { code: 'LEDGER_CACHE_MISMATCH' });
    }
    total += d;
    return { ...i, paid };
  });
  if (delta.size) {
    throw new AppError('Allocation points at a missing schedule item', {
      code: 'LEDGER_CACHE_MISMATCH',
    });
  }
  const res = await Booking.updateOne(
    { orgId, _id: booking._id, __v: booking.__v },
    { $set: { schedule, paidTotal: (booking.paidTotal ?? 0) + total }, $inc: { __v: 1 } },
    { session },
  );
  if (!res.matchedCount) {
    throw new ConflictError('The booking changed meanwhile — try again', { code: 'BOOKING_BUSY' });
  }
}

export async function validatePaymentTarget(orgId, payment) {
  if (payment.bankAccountId) await accounts.assertActiveBankAccount(orgId, payment.bankAccountId);
}

export function normalizeNominees(list = []) {
  return list.map((n, i) => {
    const phone = n.phone ? normalizePhone(n.phone) : null;
    if (n.phone && !phone) {
      throw new BadRequestError('Invalid phone number', {
        code: 'INVALID_PHONE',
        details: [{ path: `nominees.${i}.phone`, message: 'Invalid phone number' }],
      });
    }
    return { ...n, phone, nid: n.nid ?? null };
  });
}

// ── Create ──────────────────────────────────────────────────────────────────────

async function replayBooking(orgId, user, prior) {
  if (String(prior.createdBy) !== user.id) {
    throw new ConflictError('This Idempotency-Key was already used', {
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }
  return { booking: await getBookingDetail(orgId, user, prior._id), replayed: true };
}

/**
 * POST /bookings. `Idempotency-Key` makes a retried request return the first result.
 * Returns { booking, replayed }.
 */
export async function createBooking({ org, user, input, idempotencyKey, ctx }) {
  const orgId = org._id;
  if (idempotencyKey) {
    const prior = await Booking.findOne({ orgId, idempotencyKey }).lean();
    if (prior) return replayBooking(orgId, user, prior);
  }

  const settings = await accounts.getAccountSettings(orgId);
  const q = await quote(orgId, user, input, settings);
  const { unit, project } = q;
  if (!project.code) {
    throw unprocessable(
      'Give the project a short code first (used in booking and receipt numbers)',
      'PROJECT_CODE_REQUIRED',
    );
  }
  if (input.expectedTotal !== undefined && input.expectedTotal !== q.breakdown.total) {
    throw new ConflictError('The price changed since the preview — check it again', {
      code: 'PRICE_CHANGED',
      details: { listTotal: q.breakdown.total },
    });
  }

  // Friendly pre-checks; the atomic transition below is what really decides.
  const manager = user.permissions.has(P.UNITS_WRITE);
  const status = effectiveStatus(unit);
  if (status === 'held' && !manager && String(unit.hold?.by) !== user.id) {
    throw new ConflictError('Someone else is holding this unit', { code: 'UNIT_HELD_BY_OTHER' });
  }
  if (!['available', 'held'].includes(status)) {
    throw new ConflictError('This unit is not available', {
      code: 'UNIT_STATE_CONFLICT',
      details: { status },
    });
  }

  const primary = await customers.getVisibleCustomer(orgId, user, input.customerId);
  const coIds = input.coApplicantIds ?? [];
  for (const id of coIds) await customers.getVisibleCustomer(orgId, user, id);
  if (input.leadId) {
    const lead = await getVisibleLead(orgId, user, input.leadId);
    if (lead.type !== 'buyer') {
      throw unprocessable('Only a buyer lead can be booked', 'INVALID_LEAD', [
        { path: 'leadId', message: 'Landowner lead' },
      ]);
    }
  }
  const nominees = normalizeNominees(input.nominees);

  const bookingMoney = q.items.find((i) => i.code === 'booking_money').amount;
  let payment = null;
  const byCheque = input.payment?.mode === 'cheque';
  if (input.payment) {
    payment = { ...input.payment, date: q.bookingDate };
    if (payment.amount < bookingMoney) {
      throw unprocessable('Less than the booking money', 'BOOKING_MONEY_SHORT', {
        required: bookingMoney,
      });
    }
    if (payment.amount > q.contract) {
      throw unprocessable('More than the price', 'OVERPAYMENT', { outstanding: q.contract });
    }
    if (byCheque) {
      if (payment.chequeDate < q.bookingDate) {
        throw unprocessable('The cheque is dated before the booking', 'INVALID_CHEQUE_DATE', [
          { path: 'payment.chequeDate', message: 'Before the booking date' },
        ]);
      }
    } else await validatePaymentTarget(orgId, payment);
  } else if (settings.bookingMoneyRequired || input.waiveReason) {
    if (!input.waiveReason) {
      throw unprocessable('Take the booking money with the booking', 'BOOKING_MONEY_REQUIRED', {
        required: bookingMoney,
      });
    }
    if (!user.permissions.has(P.BOOKINGS_OVERRIDE)) {
      throw new ForbiddenError('Only a manager can book without booking money', {
        code: 'WAIVE_NOT_ALLOWED',
      });
    }
  }

  const schedule = q.items.map((i) => ({
    _id: new ObjectId(),
    seq: i.seq,
    code: i.code,
    label: i.label,
    labelBn: i.labelBn ?? null,
    dueDate: i.dueDate ? parseDhakaDate(i.dueDate) : null,
    amount: i.amount,
    paid: 0,
    milestoneKey: i.milestoneKey ?? null,
  }));
  // A cheque is only acknowledged now; it pays the schedule when it clears (owner decision Q1).
  const allocations = payment && !byCheque ? allocateOrThrow(schedule, payment.amount) : [];
  for (const a of allocations) {
    const item = schedule.find((s) => s._id === a.itemId);
    item.paid += a.amount;
  }

  const counterKey = `booking:${project._id}`;
  await ensureCounter(orgId, counterKey);
  if (payment && !byCheque) await accounts.prepareReceiptCounter(org, project._id, payment.date);

  const now = new Date();
  const heldBy = manager ? { status: 'held' } : { status: 'held', 'hold.by': oid(user.id) };
  const match = {
    $or: [{ status: 'available' }, { status: 'held', 'hold.until': { $lte: now } }, heldBy],
  };

  let booking;
  let receipt = null;
  let cheque = null;
  let unitAfter;
  try {
    await withTransaction(async (session) => {
      const seq = await nextSeq(orgId, counterKey, { session });
      const bookingNo = `${project.code}-BK-${String(seq).padStart(5, '0')}`;
      unitAfter = await transitionUnit({
        orgId,
        unitId: unit._id,
        from: ['available', 'held'],
        to: 'booked',
        match,
        set: { hold: null },
        ctx,
        action: 'unit.booked',
        meta: { bookingNo },
        session,
      });
      const [doc] = await Booking.create(
        [
          {
            orgId,
            bookingNo,
            seq,
            projectId: project._id,
            blockId: unit.blockId,
            unitId: unit._id,
            unitCode: unit.code,
            kind: unit.kind,
            customerId: primary._id,
            customerName: primary.name,
            coApplicantIds: coIds.map(oid),
            nominees,
            leadId: input.leadId ? oid(input.leadId) : null,
            soldBy: oid(user.id),
            soldByName: user.name,
            bookingDate: parseDhakaDate(q.bookingDate),
            price: {
              strategy: q.breakdown.strategy,
              rateUnit: q.breakdown.rateUnit ?? null,
              lines: q.breakdown.lines,
              listTotal: q.breakdown.total,
              baseAmount: q.baseAmount,
              discount: {
                amount: q.discount,
                reason: input.discount?.reason ?? null,
                capBps: q.capBps,
              },
              contractTotal: q.contract,
            },
            plan: q.plan
              ? { planId: q.plan._id, name: q.plan.name, spec: q.plan.spec }
              : { planId: null, name: null, spec: null },
            schedule,
            paidTotal: byCheque ? 0 : (payment?.amount ?? 0),
            bookingMoneyWaived: input.waiveReason
              ? { reason: input.waiveReason, by: oid(user.id), byName: user.name }
              : null,
            note: input.note ?? null,
            idempotencyKey: idempotencyKey ?? null,
            createdBy: oid(user.id),
          },
        ],
        { session },
      );
      booking = doc.toObject();
      if (byCheque) {
        cheque = await accounts.createChequeDoc({
          orgId,
          booking,
          customerName: primary.name,
          input: { ...payment, receivedDate: q.bookingDate },
          user,
          session,
        });
      } else if (payment) {
        receipt = await accounts.createReceiptDocs({
          org,
          session,
          booking,
          project,
          customerName: primary.name,
          payment,
          allocations,
          context: 'booking',
          user,
        });
      }
      await customers.grantAccess(orgId, [primary._id, ...coIds], user.id, { session });
      await audit(ctx, 'booking.create', {
        entity: { type: 'Booking', id: booking._id },
        meta: {
          bookingNo,
          unitCode: unit.code,
          customerNo: primary.customerNo,
          contractTotal: q.contract,
          discount: q.discount,
          ...(receipt && { receiptNo: receipt.receiptNo, paid: receipt.amount }),
          ...(cheque && { chequeNo: cheque.chequeNo, chequeAmount: cheque.amount }),
          ...(input.waiveReason && { waived: input.waiveReason }),
        },
        session,
      });
    });
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.idempotencyKey) {
      const prior = await Booking.findOne({ orgId, idempotencyKey }).lean();
      if (prior) return replayBooking(orgId, user, prior);
    }
    if (err?.code === 11000 && err.keyPattern?.unitId) {
      throw new ConflictError('This unit is already booked', { code: 'UNIT_STATE_CONFLICT' });
    }
    throw err;
  }

  await announceUnitChanges(orgId, [unitAfter]);
  if (input.leadId) {
    await markLeadWon(orgId, input.leadId, {
      actorId: user.id,
      bookingId: booking._id,
      bookingNo: booking.bookingNo,
      unitCode: unit.code,
    }).catch((err) => log.warn({ err: { message: err.message } }, 'lead → won failed'));
  }
  if (receipt) await accounts.notifyReceipt({ org, receipt, customer: primary });
  // B4.3 documents — after the commit, never failing the booking.
  await docs.safely('booking_form', () => docs.issueBookingForm(org, booking, user));
  if (receipt)
    await docs.safely('receipt', () => docs.issueReceiptDoc(org, booking, receipt, user));
  if (cheque)
    await docs.safely('cheque_ack', () => docs.issueChequeAck(org, booking, cheque, user));
  return { booking: await getBookingDetail(orgId, user, booking._id), replayed: false };
}

// ── Edit (nominees, note) ───────────────────────────────────────────────────────

export async function updateBooking({ orgId, user, id, patch, ctx }) {
  const b = await getVisibleBooking(orgId, user, id);
  if (b.__v !== patch.version) throw staleVersion();
  const set = {};
  if (patch.nominees !== undefined) set.nominees = normalizeNominees(patch.nominees);
  if (patch.note !== undefined) set.note = patch.note;
  const res = await Booking.updateOne(
    { orgId, _id: b._id, __v: b.__v },
    { $set: set, $inc: { __v: 1 } },
  );
  if (!res.matchedCount) throw staleVersion();
  await audit(ctx, 'booking.update', {
    entity: { type: 'Booking', id: b._id },
    meta: { bookingNo: b.bookingNo, fields: Object.keys(set) },
  });
  return getBookingDetail(orgId, user, b._id);
}

// ── Receipts ────────────────────────────────────────────────────────────────────

/** POST /bookings/:id/receipts — returns { receipt, replayed }. */
export async function addPayment({ org, user, bookingId, input, idempotencyKey, ctx }) {
  const orgId = org._id;
  const replay = async (prior) => {
    if (String(prior.bookingId) !== String(bookingId) || String(prior.receivedBy) !== user.id) {
      throw new ConflictError('This Idempotency-Key was already used', {
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    return { receipt: (await accounts.serializeReceipts(orgId, [prior]))[0], replayed: true };
  };
  if (idempotencyKey) {
    const prior = await accounts.findReceiptByIdempotencyKey(orgId, idempotencyKey);
    if (prior) return replay(prior);
  }

  const booking = await getVisibleBooking(orgId, user, bookingId);
  if (booking.status !== 'active') {
    throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
  }
  const settings = await accounts.getAccountSettings(orgId);
  const today = todayDhaka();
  const date = input.date ?? today;
  checkBusinessDate(date, today, settings.receiptBackdateDays ?? 31, 'RECEIPT');
  if (date < toDhakaDate(booking.bookingDate)) {
    throw unprocessable('The receipt date is before the booking date', 'RECEIPT_BEFORE_BOOKING', [
      { path: 'date', message: 'Before the booking' },
    ]);
  }
  const project = await getProject(orgId, booking.projectId);
  if (!project.code) {
    throw unprocessable('Give the project a short code first', 'PROJECT_CODE_REQUIRED');
  }
  await validatePaymentTarget(orgId, input);
  allocateOrThrow(booking.schedule, input.amount); // friendly OVERPAYMENT before the transaction
  await accounts.prepareReceiptCounter(org, project._id, date);
  const customer = (await customers.customersByIds(orgId, [booking.customerId])).get(
    String(booking.customerId),
  );

  let receipt;
  try {
    await withTransaction(async (session) => {
      const fresh = await Booking.findOne({ orgId, _id: booking._id }).session(session).lean();
      if (fresh.status !== 'active') {
        throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
      }
      const allocations = allocateOrThrow(fresh.schedule, input.amount);
      receipt = await accounts.createReceiptDocs({
        org,
        session,
        booking: fresh,
        project,
        customerName: customer?.name ?? fresh.customerName,
        payment: { ...input, date },
        allocations,
        context: 'payment',
        user,
        idempotencyKey,
      });
      await applyPaid(orgId, fresh, allocations, 1, session);
      await audit(ctx, 'receipt.create', {
        entity: { type: 'Receipt', id: receipt._id },
        meta: {
          receiptNo: receipt.receiptNo,
          bookingNo: fresh.bookingNo,
          amount: receipt.amount,
          mode: receipt.mode,
        },
        session,
      });
    });
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.idempotencyKey) {
      const prior = await accounts.findReceiptByIdempotencyKey(orgId, idempotencyKey);
      if (prior) return replay(prior);
    }
    throw err;
  }
  await accounts.notifyReceipt({ org, receipt, customer });
  await docs.safely('receipt', async () =>
    docs.issueReceiptDoc(
      org,
      await Booking.findOne({ orgId, _id: booking._id }).lean(),
      receipt,
      user,
    ),
  );
  return { receipt: (await accounts.serializeReceipts(orgId, [receipt]))[0], replayed: false };
}

/**
 * POST /receipts/:id/reverse (receipts:reverse). The receipt keeps its number, marked
 * reversed; the ledger gets a negative entry; the schedule cache is reduced.
 */
export async function reverseReceipt({ org, user, receiptId, reason, ctx }) {
  const orgId = org._id;
  const r = await accounts.getReceiptDoc(orgId, receiptId);
  if (r.status === 'reversed') {
    throw new ConflictError('This receipt is already reversed', { code: 'ALREADY_REVERSED' });
  }
  let updated;
  await withTransaction(async (session) => {
    const receipt = await accounts.getReceiptDoc(orgId, receiptId, { session });
    if (receipt.status === 'reversed') {
      throw new ConflictError('This receipt is already reversed', { code: 'ALREADY_REVERSED' });
    }
    const booking = await Booking.findOne({ orgId, _id: receipt.bookingId })
      .session(session)
      .lean();
    updated = await accounts.reverseReceiptDocs({
      orgId,
      session,
      receipt,
      reason,
      user,
      date: todayDhaka(),
    });
    await applyPaid(orgId, booking, receipt.allocations, -1, session);
    await audit(ctx, 'receipt.reverse', {
      entity: { type: 'Receipt', id: receipt._id },
      meta: {
        receiptNo: receipt.receiptNo,
        bookingNo: receipt.bookingNo,
        amount: receipt.amount,
        reason,
      },
      session,
    });
  });
  await docs.safely('void receipt', () =>
    voidDocuments(orgId, { type: 'receipt', refId: updated._id }, `Reversed: ${reason}`),
  );
  return (await accounts.serializeReceipts(orgId, [updated]))[0];
}

/** Receipts visible to this user: their own bookings' receipts without bookings:read_all. */
export function receiptScope(user) {
  return canReadAllBookings(user) ? {} : { soldBy: oid(user.id) };
}

export async function getVisibleReceipt(orgId, user, id) {
  const r = await accounts.getReceiptDoc(orgId, id);
  if (!canReadAllBookings(user) && String(r.soldBy) !== user.id) {
    throw new NotFoundError('Receipt not found');
  }
  return (await accounts.serializeReceipts(orgId, [r]))[0];
}

// ── Ledger / statement ──────────────────────────────────────────────────────────

/**
 * GET /bookings/:id/ledger — money history with a running total, the schedule, and an integrity
 * check: the schedule cache must equal what the append-only ledger says.
 */
export async function getBookingLedger(orgId, user, id) {
  const b = await getVisibleBooking(orgId, user, id);
  return buildLedger(b, await accounts.ledgerOfBooking(orgId, b._id), todayDhaka());
}

/**
 * Ledger view of a booking (also the statement document's data). `paidToDate` counts receipts
 * and reversals; refunds (after a cancellation) are money going back and show in `refunded`.
 */
export function buildLedger(b, entries, asOf) {
  let running = 0;
  let refunded = 0;
  const perItem = new Map();
  const rows = entries.map((e) => {
    if (e.type === 'refund') refunded -= e.amount;
    else running += e.amount;
    for (const a of e.allocations) {
      const k = String(a.itemId);
      perItem.set(k, (perItem.get(k) ?? 0) + a.amount);
    }
    return {
      id: String(e._id),
      date: toDhakaDate(e.date),
      type: e.type,
      ref: e.ref ?? null,
      receiptId: idOrNull(e.receiptId),
      amount: e.amount,
      paidToDate: running,
      refundedToDate: refunded,
      note: e.note ?? null,
      by: e.by ? { id: String(e.by), name: e.byName ?? null } : null,
      createdAt: e.createdAt,
    };
  });
  const mismatched = b.schedule
    .filter((i) => (perItem.get(String(i._id)) ?? 0) !== (i.paid ?? 0))
    .map((i) => String(i._id));
  const totals = scheduleTotals(b.schedule, asOf);
  return {
    bookingId: String(b._id),
    bookingNo: b.bookingNo,
    entries: rows,
    refunded,
    schedule: b.schedule.map((i) => toScheduleItem(i, asOf)),
    totals: {
      ...totals,
      nextDue: totals.nextDue && {
        ...totals.nextDue,
        dueDate: toDhakaDate(totals.nextDue.dueDate),
      },
    },
    integrity: {
      ok: running === (b.paidTotal ?? 0) && !mismatched.length,
      paidTotal: b.paidTotal ?? 0,
      ledgerTotal: running,
      mismatchedItems: mismatched,
    },
  };
}
