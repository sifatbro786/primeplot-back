import mongoose from 'mongoose';
import { P } from '#shared/auth/permissions.js';
import { ConflictError, ForbiddenError, NotFoundError } from '#shared/errors/AppError.js';
import { withTransaction } from '#shared/db/withTransaction.js';
import { bpsOf } from '#shared/utils/money.js';
import { parseDhakaDate, toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { audit } from '#modules/audit/audit.service.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { remainingOf, scheduleTotals } from '#modules/accounts/allocation.js';
import { ensureCounter } from '#modules/accounts/counter.model.js';
import * as customers from '#modules/customers/customer.service.js';
import { voidDocuments } from '#modules/documents/document.service.js';
import { autoInvite } from '#modules/portal/portalAccount.service.js';
import { getProject } from '#modules/projects/project.service.js';
import { announceUnitChanges, transitionUnit } from '#modules/units/unit.service.js';
import { Booking } from './booking.model.js';
import {
  getBookingDetail,
  getVisibleBooking,
  normalizeNominees,
  unprocessable,
  validatePaymentTarget,
} from './booking.service.js';
import * as docs from './documentData.js';

/**
 * After the sale (B4.2): allotment → registration → handover, schedule changes (charges,
 * calling a milestone, rescheduling), transfer to a new holder, cancellation and refunds.
 * Owner decisions 2026-10-14: allotment warns (never blocks) when the down payment is unpaid;
 * cancellation keeps project.salesPolicy.cancellationDeductionBps of the amount paid (manager may
 * override with a reason); transfer adds project.salesPolicy.transferFee and needs no overdue dues.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

const busy = () =>
  new ConflictError('This booking was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

/** Version-checked write of a booking read in the same transaction. */
async function writeBooking(orgId, b, update, session) {
  const res = await Booking.updateOne(
    { orgId, _id: b._id, __v: b.__v },
    { ...update, $inc: { ...(update.$inc ?? {}), __v: 1 } },
    { session },
  );
  if (!res.matchedCount) throw busy();
}

function requireActive(b) {
  if (b.status !== 'active') {
    throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
  }
}

function requireStage(b, stages) {
  requireActive(b);
  if (!stages.includes(b.stage ?? 'booked')) {
    throw new ConflictError(`Not possible at stage "${b.stage}"`, {
      code: 'BOOKING_STAGE_CONFLICT',
      details: { stage: b.stage ?? 'booked' },
    });
  }
}

/** Business date of an event: default today, never in the future, not before the booking. */
function eventDate(input, b) {
  const today = todayDhaka();
  const date = input ?? today;
  const booked = toDhakaDate(b.bookingDate);
  if (date > today) {
    throw unprocessable('The date cannot be in the future', 'DATE_IN_FUTURE', [
      { path: 'date', message: 'In the future' },
    ]);
  }
  if (date < booked) {
    throw unprocessable('The date is before the booking', 'DATE_TOO_EARLY', [
      { path: 'date', message: `Not before ${booked}` },
    ]);
  }
  return date;
}

const act = (date, user, note) => ({
  date: parseDhakaDate(date),
  by: user ? oid(user.id) : null,
  byName: user?.name ?? null,
  note: note ?? null,
});

const fresh = (orgId, id, session) =>
  Booking.findOne({ orgId, _id: id })
    .session(session ?? null)
    .lean();

// ── Charges & schedule ──────────────────────────────────────────────────────────

/**
 * Append a `charge` item (outside the contract price) inside the caller's transaction. Used by
 * manual charges, cheque bounce fees and transfer fees.
 */
export async function appendCharge(orgId, booking, charge, session) {
  const seq = Math.max(0, ...booking.schedule.map((i) => i.seq)) + 1;
  const item = {
    _id: new ObjectId(),
    seq,
    code: 'charge',
    chargeKind: charge.chargeKind,
    label: charge.label,
    labelBn: charge.labelBn ?? null,
    dueDate: parseDhakaDate(charge.dueDate),
    amount: charge.amount,
    paid: 0,
    note: charge.note ?? null,
  };
  await writeBooking(orgId, booking, { $push: { schedule: item } }, session);
  return item;
}

export async function addCharge({ orgId, user, bookingId, input, ctx }) {
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireActive(b);
  if (input.dueDate < toDhakaDate(b.bookingDate)) {
    throw unprocessable('The due date is before the booking', 'DATE_TOO_EARLY', [
      { path: 'dueDate', message: 'Before the booking' },
    ]);
  }
  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    const item = await appendCharge(orgId, cur, { ...input, chargeKind: input.kind }, session);
    await audit(ctx, 'booking.charge_add', {
      entity: { type: 'Booking', id: b._id },
      meta: {
        bookingNo: b.bookingNo,
        kind: input.kind,
        amount: input.amount,
        itemId: String(item._id),
      },
      session,
    });
  });
  return getBookingDetail(orgId, user, b._id);
}

/** Remove an unpaid charge (a waiver). Paid or part-paid charges stay. */
export async function waiveCharge({ orgId, user, bookingId, itemId, reason, ctx }) {
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireActive(b);
  const item = b.schedule.find((i) => String(i._id) === itemId);
  if (!item || item.code !== 'charge') throw new NotFoundError('Charge not found');
  if (item.paid) {
    throw new ConflictError('Part of this charge is already paid', { code: 'ITEM_PAID_LOCKED' });
  }
  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    await writeBooking(orgId, cur, { $pull: { schedule: { _id: item._id, paid: 0 } } }, session);
    await audit(ctx, 'booking.charge_waive', {
      entity: { type: 'Booking', id: b._id },
      meta: { bookingNo: b.bookingNo, label: item.label, amount: item.amount, reason },
      session,
    });
  });
  return getBookingDetail(orgId, user, b._id);
}

/** Give a milestone / handover item (or any unpaid item) its due date. */
export async function callItem({ orgId, user, bookingId, itemId, input, ctx }) {
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireActive(b);
  const item = b.schedule.find((i) => String(i._id) === itemId);
  if (!item) throw new NotFoundError('Schedule item not found');
  if (!remainingOf(item)) {
    throw new ConflictError('This item is already paid', { code: 'ITEM_PAID_LOCKED' });
  }
  if (input.dueDate < toDhakaDate(b.bookingDate)) {
    throw unprocessable('The due date is before the booking', 'DATE_TOO_EARLY', [
      { path: 'dueDate', message: 'Before the booking' },
    ]);
  }
  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    const idx = cur.schedule.findIndex((i) => String(i._id) === itemId);
    await writeBooking(
      orgId,
      cur,
      {
        $set: {
          [`schedule.${idx}.dueDate`]: parseDhakaDate(input.dueDate),
          ...(input.note && { [`schedule.${idx}.note`]: input.note }),
        },
      },
      session,
    );
    await audit(ctx, 'booking.item_call', {
      entity: { type: 'Booking', id: b._id },
      meta: {
        bookingNo: b.bookingNo,
        label: item.label,
        from: item.dueDate ? toDhakaDate(item.dueDate) : null,
        to: input.dueDate,
      },
      session,
    });
  });
  return getBookingDetail(orgId, user, b._id);
}

/**
 * PUT /bookings/:id/schedule — replace the contract items (charges stay as they are).
 * Rules: total = contract price exactly; one booking-money item, kept (same id); an item with
 * payments must stay (same id) with amount ≥ paid; a fully paid item cannot change at all.
 */
export async function reschedule({ orgId, user, bookingId, input, ctx }) {
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireActive(b);
  if (b.__v !== input.version) throw busy();
  const contractItems = b.schedule.filter((i) => i.code !== 'charge');
  const byId = new Map(contractItems.map((i) => [String(i._id), i]));
  const booked = toDhakaDate(b.bookingDate);
  const problems = [];

  const sum = input.items.reduce((s, i) => s + i.amount, 0);
  if (sum !== b.price.contractTotal) {
    throw unprocessable(
      'The schedule must add up to the contract price',
      'SCHEDULE_TOTAL_MISMATCH',
      {
        contract: b.price.contractTotal,
        scheduled: sum,
        difference: b.price.contractTotal - sum,
      },
    );
  }
  const bm = input.items.filter((i) => i.code === 'booking_money');
  const oldBm = contractItems.find((i) => i.code === 'booking_money');
  if (bm.length !== 1 || (oldBm && bm[0].id !== String(oldBm._id))) {
    problems.push({ path: 'items', message: 'Keep the existing booking-money item' });
  }
  const kept = new Set();
  input.items.forEach((n, k) => {
    if (n.id) {
      const old = byId.get(n.id);
      if (!old) return problems.push({ path: `items.${k}.id`, message: 'Unknown item' });
      kept.add(n.id);
      if (old.code !== n.code)
        problems.push({ path: `items.${k}.code`, message: 'Type cannot change' });
      if (n.amount < (old.paid ?? 0)) {
        problems.push({ path: `items.${k}.amount`, message: 'Less than already paid' });
      }
      const fullyPaid = old.paid && !remainingOf(old);
      const sameDate = (n.dueDate ?? null) === (old.dueDate ? toDhakaDate(old.dueDate) : null);
      if (fullyPaid && (n.amount !== old.amount || !sameDate)) {
        problems.push({ path: `items.${k}`, message: 'A paid item cannot change' });
      }
    }
    if (n.dueDate && n.dueDate < booked) {
      problems.push({ path: `items.${k}.dueDate`, message: 'Before the booking date' });
    }
  });
  for (const old of contractItems) {
    if (!kept.has(String(old._id)) && old.paid) {
      problems.push({ path: 'items', message: `"${old.label}" has payments and must stay` });
    }
  }
  if (problems.length)
    throw unprocessable('The new schedule is not valid', 'INVALID_SCHEDULE', problems);

  const charges = b.schedule.filter((i) => i.code === 'charge');
  const next = [
    ...input.items.map((n) => {
      const old = n.id ? byId.get(n.id) : null;
      return {
        _id: old?._id ?? new ObjectId(),
        code: n.code,
        label: n.label ?? old?.label ?? n.code,
        labelBn: n.labelBn ?? old?.labelBn ?? null,
        dueDate: n.dueDate ? parseDhakaDate(n.dueDate) : null,
        amount: n.amount,
        paid: old?.paid ?? 0,
        milestoneKey: old?.milestoneKey ?? null,
        chargeKind: null,
        note: old?.note ?? null,
      };
    }),
    ...charges,
  ].map((i, k) => ({ ...i, seq: k + 1 }));

  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    if (cur.__v !== b.__v) throw busy();
    await writeBooking(orgId, cur, { $set: { schedule: next } }, session);
    await audit(ctx, 'booking.reschedule', {
      entity: { type: 'Booking', id: b._id },
      meta: {
        bookingNo: b.bookingNo,
        reason: input.reason,
        before: contractItems.map((i) => ({
          label: i.label,
          due: i.dueDate ? toDhakaDate(i.dueDate) : null,
          amount: i.amount,
        })),
        after: input.items.map((i) => ({
          label: i.label ?? null,
          due: i.dueDate ?? null,
          amount: i.amount,
        })),
      },
      session,
    });
  });
  return getBookingDetail(orgId, user, b._id);
}

// ── Stages ──────────────────────────────────────────────────────────────────────

async function moveStage({ org, b, from, to, field, value, ctx, action, meta }) {
  const orgId = org._id;
  let unitAfter;
  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    requireStage(cur, [from]);
    unitAfter = await transitionUnit({
      orgId,
      unitId: cur.unitId,
      from: [from],
      to,
      ctx,
      action: `unit.${to}`,
      meta: { bookingNo: cur.bookingNo },
      session,
    });
    await writeBooking(orgId, cur, { $set: { stage: to, [field]: value } }, session);
    await audit(ctx, action, {
      entity: { type: 'Booking', id: b._id },
      meta: { bookingNo: cur.bookingNo, ...meta },
      session,
    });
  });
  await announceUnitChanges(orgId, [unitAfter]);
}

/** Owner decision Q6: a warning, not a block, when the down payment is not fully paid. */
export async function allot({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireStage(b, ['booked']);
  const date = eventDate(input.date, b);
  const warnings = [];
  const unpaid = (code) => b.schedule.some((i) => i.code === code && remainingOf(i));
  if (unpaid('booking_money')) warnings.push('BOOKING_MONEY_UNPAID');
  if (unpaid('down_payment')) warnings.push('DOWN_PAYMENT_UNPAID');
  await moveStage({
    org,
    user,
    b,
    from: 'booked',
    to: 'allotted',
    field: 'allotment',
    value: act(date, user, input.note),
    ctx,
    action: 'booking.allot',
    meta: { date, warnings },
  });
  const after = await fresh(orgId, b._id);
  await docs.safely('allotment_letter', () => docs.issueAllotmentLetter(org, after, user));
  return { booking: await getBookingDetail(orgId, user, b._id), warnings };
}

export async function register({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireStage(b, ['allotted']);
  const date = eventDate(input.date, b);
  const outstanding = scheduleTotals(b.schedule, todayDhaka()).outstanding;
  const warnings = outstanding > 0 ? ['DUES_OUTSTANDING'] : [];
  await moveStage({
    org,
    user,
    b,
    from: 'allotted',
    to: 'registered',
    field: 'registration',
    value: {
      ...act(date, user, input.note),
      deedNo: input.deedNo,
      subRegistryOffice: input.subRegistryOffice ?? null,
    },
    ctx,
    action: 'booking.register',
    meta: { date, deedNo: input.deedNo, outstanding },
  });
  return { booking: await getBookingDetail(orgId, user, b._id), warnings };
}

export async function handover({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireStage(b, ['registered']);
  const date = eventDate(input.date, b);
  await moveStage({
    org,
    user,
    b,
    from: 'registered',
    to: 'handed_over',
    field: 'handover',
    value: act(date, user, input.note),
    ctx,
    action: 'booking.handover',
    meta: { date },
  });
  return { booking: await getBookingDetail(orgId, user, b._id), warnings: [] };
}

// ── Transfer ────────────────────────────────────────────────────────────────────

export async function transfer({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireStage(b, ['booked', 'allotted']);
  const date = eventDate(input.date, b);
  if (input.toCustomerId === String(b.customerId)) {
    throw unprocessable('The new holder is the current holder', 'SAME_HOLDER', [
      { path: 'toCustomerId', message: 'Same customer' },
    ]);
  }
  const totals = scheduleTotals(b.schedule, todayDhaka());
  if (totals.overdue > 0) {
    throw new ConflictError('Clear the overdue dues before a transfer', {
      code: 'OVERDUE_DUES',
      details: { overdue: totals.overdue },
    });
  }
  if ((await accounts.openChequesOf(orgId, b._id)).length) {
    throw new ConflictError('Settle or return the open cheques first', { code: 'OPEN_CHEQUES' });
  }
  const to = await customers.getVisibleCustomer(orgId, user, input.toCustomerId);
  const coIds = input.coApplicantIds ?? [];
  for (const id of coIds) await customers.getVisibleCustomer(orgId, user, id);
  const nominees = normalizeNominees(input.nominees ?? []);
  const project = await getProject(orgId, b.projectId);
  const fee = input.waiveFeeReason ? 0 : (project.salesPolicy?.transferFee ?? 0);

  const entry = {
    _id: new ObjectId(),
    customerId: b.customerId,
    customerName: b.customerName,
    coApplicantIds: b.coApplicantIds ?? [],
    nominees: b.nominees ?? [],
    until: parseDhakaDate(date),
    toCustomerId: to._id,
    fee,
    feeWaivedReason: input.waiveFeeReason ?? null,
    by: oid(user.id),
    byName: user.name,
    note: input.note ?? null,
  };
  await withTransaction(async (session) => {
    let cur = await fresh(orgId, b._id, session);
    if (fee > 0) {
      await appendCharge(
        orgId,
        cur,
        {
          chargeKind: 'transfer_fee',
          label: 'Transfer fee',
          labelBn: 'হস্তান্তর ফি',
          amount: fee,
          dueDate: date,
        },
        session,
      );
      cur = await fresh(orgId, b._id, session);
    }
    await writeBooking(
      orgId,
      cur,
      {
        $set: {
          customerId: to._id,
          customerName: to.name,
          coApplicantIds: coIds.map(oid),
          nominees,
        },
        $push: { holders: entry },
      },
      session,
    );
    await customers.grantAccess(orgId, [to._id, ...coIds], String(b.soldBy), { session });
    await audit(ctx, 'booking.transfer', {
      entity: { type: 'Booking', id: b._id },
      meta: {
        bookingNo: b.bookingNo,
        from: b.customerName,
        to: to.name,
        fee,
        ...(input.waiveFeeReason && { feeWaived: input.waiveFeeReason }),
      },
      session,
    });
  });

  const after = await fresh(orgId, b._id);
  await docs.safely('transfer docs', async () => {
    await voidDocuments(
      orgId,
      { bookingId: b._id, type: { $in: ['booking_form', 'allotment_letter'] } },
      `Transferred to ${to.name}`,
    );
    await docs.issueTransferLetter(org, after, entry, user);
    await docs.issueBookingForm(org, after, user);
    if (after.allotment) await docs.issueAllotmentLetter(org, after, user);
  });
  // B5.1: the new holder gets a portal login (the old holder simply stops seeing the booking).
  await autoInvite(org, {
    holderId: after.customerId,
    coApplicantIds: after.coApplicantIds ?? [],
    by: user,
  });
  return getBookingDetail(orgId, user, b._id);
}

// ── Cancellation & refunds ──────────────────────────────────────────────────────

async function cancellationTerms(orgId, b, deductionAmount) {
  const project = await getProject(orgId, b.projectId);
  const bps = project.salesPolicy?.cancellationDeductionBps ?? 1000;
  const paid = b.paidTotal ?? 0;
  const policy = bpsOf(paid, bps);
  const deduction = deductionAmount ?? policy;
  return {
    paid,
    deductionBps: deductionAmount === undefined || deductionAmount === policy ? bps : null,
    policyDeduction: policy,
    deduction,
    refundable: paid - deduction,
    overridden: deductionAmount !== undefined && deductionAmount !== policy,
  };
}

/** POST /bookings/:id/cancel/preview — the numbers before confirming. */
export async function cancelPreview({ orgId, user, bookingId, input }) {
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireStage(b, ['booked', 'allotted']);
  const t = await cancellationTerms(orgId, b, input.deductionAmount);
  const open = await accounts.openChequesOf(orgId, b._id);
  return {
    ...t,
    openCheques: open.length,
    blockers: open.length ? ['OPEN_CHEQUES'] : [],
  };
}

export async function cancel({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const b = await getVisibleBooking(orgId, user, bookingId);
  requireStage(b, ['booked', 'allotted']);
  const date = eventDate(input.date, b);
  if ((await accounts.openChequesOf(orgId, b._id)).length) {
    throw new ConflictError('Clear or return the open cheques first', { code: 'OPEN_CHEQUES' });
  }
  const t = await cancellationTerms(orgId, b, input.deductionAmount);
  if (t.deduction > t.paid) {
    throw unprocessable('The deduction is more than what was paid', 'INVALID_DEDUCTION', [
      { path: 'deductionAmount', message: `At most ${t.paid}` },
    ]);
  }
  if (t.overridden) {
    if (!user.permissions.has(P.BOOKINGS_OVERRIDE)) {
      throw new ForbiddenError('Only a manager can change the deduction', {
        code: 'DEDUCTION_OVERRIDE_NOT_ALLOWED',
      });
    }
    if (!input.overrideReason) {
      throw unprocessable(
        'Say why the deduction differs from the policy',
        'OVERRIDE_REASON_REQUIRED',
        [{ path: 'overrideReason', message: 'Required' }],
      );
    }
  }

  const units = [];
  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    requireStage(cur, ['booked', 'allotted']);
    units.length = 0;
    await transitionUnit({
      orgId,
      unitId: cur.unitId,
      from: ['booked', 'allotted'],
      to: 'cancelled',
      ctx,
      action: 'unit.cancelled',
      meta: { bookingNo: cur.bookingNo },
      session,
    });
    units.push(
      await transitionUnit({
        orgId,
        unitId: cur.unitId,
        from: ['cancelled'],
        to: 'available',
        set: { hold: null },
        ctx,
        action: 'unit.relisted',
        meta: { bookingNo: cur.bookingNo },
        session,
      }),
    );
    await writeBooking(
      orgId,
      cur,
      {
        $set: {
          status: 'cancelled',
          cancellation: {
            ...act(date, user, null),
            reason: input.reason,
            paid: t.paid,
            deductionBps: t.deductionBps,
            deduction: t.deduction,
            refundable: t.refundable,
            refunded: 0,
            overrideReason: t.overridden ? input.overrideReason : null,
          },
        },
      },
      session,
    );
    await audit(ctx, 'booking.cancel', {
      entity: { type: 'Booking', id: b._id },
      meta: {
        bookingNo: b.bookingNo,
        reason: input.reason,
        paid: t.paid,
        deduction: t.deduction,
        refundable: t.refundable,
        ...(t.overridden && {
          policyDeduction: t.policyDeduction,
          overrideReason: input.overrideReason,
        }),
      },
      session,
    });
  });
  await announceUnitChanges(orgId, units);

  const after = await fresh(orgId, b._id);
  await docs.safely('cancellation docs', async () => {
    await voidDocuments(
      orgId,
      { bookingId: b._id, type: { $in: ['booking_form', 'allotment_letter'] } },
      'Booking cancelled',
    );
    await docs.issueCancellationLetter(org, after, user);
  });
  return getBookingDetail(orgId, user, b._id);
}

/** POST /bookings/:id/refunds — pay back (part of) the refundable amount of a cancelled booking. */
export async function addRefund({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const b = await getVisibleBooking(orgId, user, bookingId);
  if (b.status !== 'cancelled') {
    throw new ConflictError('Refunds are for cancelled bookings', {
      code: 'BOOKING_NOT_CANCELLED',
    });
  }
  const due = b.cancellation.refundable - (b.cancellation.refunded ?? 0);
  if (input.amount > due) {
    throw unprocessable('More than the refund still due', 'REFUND_EXCEEDS_DUE', { refundDue: due });
  }
  const date = eventDate(input.date, b);
  await validatePaymentTarget(orgId, input);
  const project = await getProject(orgId, b.projectId);
  if (!project.code)
    throw unprocessable('Give the project a short code first', 'PROJECT_CODE_REQUIRED');
  await ensureCounter(orgId, accounts.refundKey(project._id));

  let entry;
  await withTransaction(async (session) => {
    const cur = await fresh(orgId, b._id, session);
    const left = cur.cancellation.refundable - (cur.cancellation.refunded ?? 0);
    if (input.amount > left) {
      throw unprocessable('More than the refund still due', 'REFUND_EXCEEDS_DUE', {
        refundDue: left,
      });
    }
    entry = await accounts.createRefundEntry({
      orgId,
      session,
      booking: cur,
      project,
      input,
      date,
      user,
    });
    await writeBooking(orgId, cur, { $inc: { 'cancellation.refunded': input.amount } }, session);
    await audit(ctx, 'booking.refund', {
      entity: { type: 'Booking', id: b._id },
      meta: { bookingNo: b.bookingNo, ref: entry.ref, amount: input.amount, mode: input.mode },
      session,
    });
  });
  return {
    refund: {
      id: String(entry._id),
      ref: entry.ref,
      date,
      amount: input.amount,
      mode: input.mode,
      note: entry.note,
    },
    refundDue: due - input.amount,
  };
}
