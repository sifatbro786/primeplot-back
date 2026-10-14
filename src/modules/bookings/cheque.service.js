import mongoose from 'mongoose';
import { P } from '#shared/auth/permissions.js';
import { ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { withTransaction } from '#shared/db/withTransaction.js';
import { addDays, parseDhakaDate, toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { audit } from '#modules/audit/audit.service.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { outstandingOf } from '#modules/accounts/allocation.js';
import * as customers from '#modules/customers/customer.service.js';
import { voidDocuments } from '#modules/documents/document.service.js';
import { notify } from '#modules/notifications/notification.service.js';
import { getProject } from '#modules/projects/project.service.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';
import { Booking } from './booking.model.js';
import {
  allocateOrThrow,
  applyPaid,
  canReadAllBookings,
  checkBusinessDate,
  getVisibleBooking,
  unprocessable,
} from './booking.service.js';
import { appendCharge } from './lifecycle.service.js';
import * as docs from './documentData.js';

/**
 * Cheque / PDC register (B4.2, owner decision Q1 = A). A cheque in hand is acknowledged
 * (unnumbered document); the numbered receipt and the allocation are made when it CLEARS, in
 * the same transaction as the cheque's move to `cleared`. A bounce reverses nothing: it adds the
 * bounce fee (accounts setting) to the schedule and alerts the seller and cheque managers.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const STALE_DAYS = 180; // Bangladesh: a cheque is valid for six months from its date

export const chequeScope = (user) => (canReadAllBookings(user) ? {} : { soldBy: oid(user.id) });

async function visibleCheque(orgId, user, id) {
  const c = await accounts.getChequeDoc(orgId, id);
  if (!canReadAllBookings(user) && String(c.soldBy) !== user.id) {
    throw new NotFoundError('Cheque not found');
  }
  return c;
}

export async function getCheque(orgId, user, id) {
  return (await accounts.serializeCheques(orgId, [await visibleCheque(orgId, user, id)]))[0];
}

function eventDate(input, today, notBefore, path = 'date') {
  const date = input ?? today;
  if (date > today) {
    throw unprocessable('The date cannot be in the future', 'DATE_IN_FUTURE', [
      { path, message: 'In the future' },
    ]);
  }
  if (notBefore && date < notBefore) {
    throw unprocessable('The date is too early', 'DATE_TOO_EARLY', [
      { path, message: `Not before ${notBefore}` },
    ]);
  }
  return date;
}

/** POST /bookings/:id/cheques — a cheque or PDC handed over for a booking. */
export async function receiveCheque({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const booking = await getVisibleBooking(orgId, user, bookingId);
  if (booking.status !== 'active') {
    throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
  }
  const today = todayDhaka();
  const receivedDate = eventDate(
    input.receivedDate,
    today,
    toDhakaDate(booking.bookingDate),
    'receivedDate',
  );
  if (input.chequeDate < addDays(today, -STALE_DAYS)) {
    throw unprocessable('This cheque is older than six months', 'CHEQUE_STALE', [
      { path: 'chequeDate', message: 'Stale cheque' },
    ]);
  }
  const open = await accounts.openChequesOf(orgId, booking._id);
  const pending = open.reduce((s, c) => s + c.amount, 0);
  const outstanding = outstandingOf(booking.schedule);
  if (input.amount > outstanding - pending) {
    throw unprocessable(
      'This cheque is more than what is left to pay (other cheques included)',
      'OVERPAYMENT',
      { outstanding, pendingCheques: pending },
    );
  }
  const customer = (await customers.customersByIds(orgId, [booking.customerId])).get(
    String(booking.customerId),
  );
  const cheque = await accounts.createChequeDoc({
    orgId,
    booking,
    customerName: customer?.name ?? booking.customerName,
    input: { ...input, receivedDate },
    user,
  });
  await audit(ctx, 'cheque.receive', {
    entity: { type: 'Cheque', id: cheque._id },
    meta: { chequeNo: cheque.chequeNo, amount: cheque.amount, bookingNo: booking.bookingNo },
  });
  await docs.safely('cheque_ack', () => docs.issueChequeAck(org, booking, cheque, user));
  return (await accounts.serializeCheques(orgId, [cheque]))[0];
}

export async function depositCheque({ org, user, chequeId, input, ctx }) {
  const orgId = org._id;
  const c = await visibleCheque(orgId, user, chequeId);
  const date = eventDate(input.date, todayDhaka(), toDhakaDate(c.receivedDate));
  await accounts.assertActiveBankAccount(orgId, input.bankAccountId);
  const updated = await accounts.chequeTransition({
    orgId,
    id: c._id,
    from: ['received', 'bounced'],
    to: 'deposited',
    date,
    user,
    note: input.note,
    set: { depositBankAccountId: oid(input.bankAccountId), depositedDate: parseDhakaDate(date) },
  });
  await audit(ctx, 'cheque.deposit', {
    entity: { type: 'Cheque', id: c._id },
    meta: {
      chequeNo: c.chequeNo,
      bankAccountId: input.bankAccountId,
      redeposit: c.status === 'bounced',
    },
  });
  return (await accounts.serializeCheques(orgId, [updated]))[0];
}

/** POST /cheques/:id/clear — honoured by the bank → numbered receipt + allocation. */
export async function clearCheque({ org, user, chequeId, input, ctx }) {
  const orgId = org._id;
  const c = await visibleCheque(orgId, user, chequeId);
  if (c.status === 'received' && !input.bankAccountId) {
    throw unprocessable('Which company account was it credited to?', 'BANK_ACCOUNT_REQUIRED', [
      { path: 'bankAccountId', message: 'Required for a cheque that was not deposited first' },
    ]);
  }
  if (!['received', 'deposited'].includes(c.status)) {
    throw new ConflictError(`A ${c.status} cheque cannot be cleared`, {
      code: 'CHEQUE_STATE_CONFLICT',
      details: { status: c.status },
    });
  }
  const settings = await accounts.getAccountSettings(orgId);
  const today = todayDhaka();
  const date = input.date ?? today;
  checkBusinessDate(date, today, settings.receiptBackdateDays ?? 31, 'RECEIPT');
  const notBefore = toDhakaDate(c.depositedDate ?? c.receivedDate);
  if (date < notBefore) {
    throw unprocessable('Cleared before it was received/deposited?', 'DATE_TOO_EARLY', [
      { path: 'date', message: `Not before ${notBefore}` },
    ]);
  }
  const bankAccountId = input.bankAccountId ?? String(c.depositBankAccountId);
  if (input.bankAccountId) await accounts.assertActiveBankAccount(orgId, input.bankAccountId);

  const booking = await Booking.findOne({ orgId, _id: c.bookingId }).lean();
  if (booking.status !== 'active') {
    throw new ConflictError('The booking is cancelled — return this cheque instead', {
      code: 'BOOKING_NOT_ACTIVE',
    });
  }
  const project = await getProject(orgId, booking.projectId);
  if (!project.code)
    throw unprocessable('Give the project a short code first', 'PROJECT_CODE_REQUIRED');
  allocateOrThrow(booking.schedule, c.amount); // friendly OVERPAYMENT before the transaction
  await accounts.prepareReceiptCounter(org, project._id, date);

  let receipt;
  await withTransaction(async (session) => {
    const fresh = await Booking.findOne({ orgId, _id: c.bookingId }).session(session).lean();
    const allocations = allocateOrThrow(fresh.schedule, c.amount);
    receipt = await accounts.createReceiptDocs({
      org,
      session,
      booking: fresh,
      project,
      customerName: c.customerName,
      payment: {
        mode: 'cheque',
        amount: c.amount,
        date,
        bankAccountId,
        instrumentNo: c.chequeNo,
        instrumentBank: c.bank,
        instrumentDate: toDhakaDate(c.chequeDate),
        note: input.note ?? null,
      },
      allocations,
      context: 'payment',
      user,
    });
    await applyPaid(orgId, fresh, allocations, 1, session);
    await accounts.chequeTransition({
      orgId,
      id: c._id,
      from: ['received', 'deposited'],
      to: 'cleared',
      date,
      user,
      note: input.note,
      set: {
        clearedDate: parseDhakaDate(date),
        receiptId: receipt._id,
        depositBankAccountId: oid(bankAccountId),
      },
      session,
    });
    await audit(ctx, 'cheque.clear', {
      entity: { type: 'Cheque', id: c._id },
      meta: { chequeNo: c.chequeNo, receiptNo: receipt.receiptNo, amount: c.amount },
      session,
    });
  });

  const customer = (await customers.customersByIds(orgId, [booking.customerId])).get(
    String(booking.customerId),
  );
  await accounts.notifyReceipt({ org, receipt, customer });
  await docs.safely('receipt', async () =>
    docs.issueReceiptDoc(
      org,
      await Booking.findOne({ orgId, _id: booking._id }).lean(),
      receipt,
      user,
    ),
  );
  return {
    cheque: await getCheque(orgId, user, c._id),
    receipt: (await accounts.serializeReceipts(orgId, [receipt]))[0],
  };
}

/** POST /cheques/:id/bounce — dishonoured: fee to the schedule, staff alerted. */
export async function bounceCheque({ org, user, chequeId, input, ctx }) {
  const orgId = org._id;
  const c = await visibleCheque(orgId, user, chequeId);
  const date = eventDate(input.date, todayDhaka(), toDhakaDate(c.depositedDate ?? c.receivedDate));
  const settings = await accounts.getAccountSettings(orgId);
  const fee = input.fee ?? settings.chequeBounceFee ?? 0;

  let updated;
  await withTransaction(async (session) => {
    updated = await accounts.chequeTransition({
      orgId,
      id: c._id,
      from: ['deposited'],
      to: 'bounced',
      date,
      user,
      note: input.reason,
      set: { bouncedDate: parseDhakaDate(date), bounceReason: input.reason },
      inc: { bounceCount: 1 },
      session,
    });
    const booking = await Booking.findOne({ orgId, _id: c.bookingId }).session(session).lean();
    if (fee > 0 && booking.status === 'active') {
      await appendCharge(
        orgId,
        booking,
        {
          chargeKind: 'cheque_bounce',
          label: `Cheque bounce fee (${c.chequeNo})`,
          labelBn: `চেক ডিজঅনার ফি (${c.chequeNo})`,
          amount: fee,
          dueDate: date,
        },
        session,
      );
    }
    await audit(ctx, 'cheque.bounce', {
      entity: { type: 'Cheque', id: c._id },
      meta: { chequeNo: c.chequeNo, reason: input.reason, fee },
      session,
    });
  });

  const managers = (await listActiveStaffWith(orgId, P.CHEQUES_MANAGE)).map((u) => u.id);
  const to = [...new Set([...managers, String(c.soldBy)].filter(Boolean))].filter(
    (id) => id !== user.id,
  );
  if (to.length) {
    await notify(orgId, to, 'cheque.bounced', {
      chequeId: String(c._id),
      chequeNo: c.chequeNo,
      bookingId: String(c.bookingId),
      bookingNo: c.bookingNo,
      customerName: c.customerName,
      amount: c.amount,
      reason: input.reason,
    });
  }
  return (await accounts.serializeCheques(orgId, [updated]))[0];
}

/** POST /cheques/:id/return — handed back to the customer (replaced, cancelled booking…). */
export async function returnCheque({ org, user, chequeId, input, ctx }) {
  const orgId = org._id;
  const c = await visibleCheque(orgId, user, chequeId);
  const updated = await accounts.chequeTransition({
    orgId,
    id: c._id,
    from: ['received', 'bounced'],
    to: 'returned',
    date: todayDhaka(),
    user,
    note: input.reason,
    set: { returnedReason: input.reason },
  });
  await audit(ctx, 'cheque.return', {
    entity: { type: 'Cheque', id: c._id },
    meta: { chequeNo: c.chequeNo, reason: input.reason },
  });
  await docs.safely('void cheque_ack', () =>
    voidDocuments(orgId, { type: 'cheque_ack', refId: c._id }, `Returned: ${input.reason}`),
  );
  return (await accounts.serializeCheques(orgId, [updated]))[0];
}
