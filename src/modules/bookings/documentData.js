import { logger } from '#config/logger.js';
import { toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { enqueue } from '#jobs/scheduler.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import * as customers from '#modules/customers/customer.service.js';
import * as documents from '#modules/documents/document.service.js';
import { getBlock, getProject } from '#modules/projects/project.service.js';
import { getUnitForSale } from '#modules/units/unit.service.js';
import { itemStatus, scheduleTotals } from '#modules/accounts/allocation.js';

/**
 * Builds the frozen snapshots for B4.3 documents and issues them. Everything a template prints
 * is copied here (strings, numbers, 'YYYY-MM-DD' dates), so a later change to a customer,
 * unit or company setting never alters an issued document.
 *
 * Issuing runs AFTER the money transaction commits and never throws to the caller (`safely`);
 * a missing document can be issued again later (GET /bookings/:id/documents backfills).
 */
const log = logger.child({ module: 'documents' });

export async function safely(what, fn) {
  try {
    return await fn();
  } catch (err) {
    log.error({ err: { message: err.message, code: err.code }, what }, 'Document issue failed');
    return null;
  }
}

function orgSnap(org) {
  return {
    name: org.name,
    nameBn: org.nameBn ?? null,
    legalName: org.legalName ?? null,
    address: org.address ?? null,
    addressBn: org.addressBn ?? null,
    phone: org.phone ?? null,
    email: org.email ?? null,
    website: org.website ?? null,
    tradeLicenseNo: org.tradeLicenseNo ?? null,
    rehabMemberNo: org.rehabMemberNo ?? null,
    logoMediaId: org.logoMediaId ? String(org.logoMediaId) : null, // rendered live, not hashed
  };
}

export function personSnap(c) {
  if (!c) return null;
  return {
    customerNo: c.customerNo,
    name: c.name,
    nameBn: c.nameBn ?? null,
    fatherName: c.fatherName ?? null,
    motherName: c.motherName ?? null,
    phone: c.phone,
    email: c.email ?? null,
    nid: c.nid ?? null,
    passportNo: c.passportNo ?? null,
    presentAddress: c.presentAddress ?? null,
    permanentAddress: c.permanentAddress ?? null,
    foreignAddress: c.foreignAddress ?? null,
  };
}

async function unitSnap(orgId, booking) {
  const u = await getUnitForSale(orgId, booking.unitId);
  const block = await getBlock(orgId, booking.projectId, u.blockId).catch(() => null);
  return {
    code: u.code,
    kind: u.kind,
    blockName: block?.name ?? null,
    floor: u.floor ?? null,
    position: u.position ?? null,
    typeLabel: u.typeLabel ?? null,
    bedrooms: u.bedrooms ?? null,
    saleableSqft: u.saleableSqft ?? null,
    saleableSqm: u.saleableSqm ?? null,
    plotNo: u.plotNo ?? null,
    road: u.road ?? null,
    roadWidthFt: u.roadWidthFt ?? null,
    landArea: u.landArea
      ? {
          value: u.landArea.value,
          unit: u.landArea.unit,
          katha: u.landArea.katha,
          decimal: u.landArea.decimal,
        }
      : null,
    facing: u.facing ?? null,
    isCorner: Boolean(u.isCorner),
    parkingSlots: u.parkingSlots ?? 0,
  };
}

/** Common part of every snapshot + the holder's preferred language. */
async function base(org, booking) {
  const orgId = org._id;
  const [project, unit, people] = await Promise.all([
    getProject(orgId, booking.projectId),
    unitSnap(orgId, booking),
    customers.customersByIds(orgId, [booking.customerId, ...(booking.coApplicantIds ?? [])]),
  ]);
  const holder = people.get(String(booking.customerId));
  return {
    locale: holder?.locale ?? org.settings?.defaultLocale ?? 'bn',
    snap: {
      org: orgSnap(org),
      project: {
        name: project.name,
        nameBn: project.nameBn ?? null,
        code: project.code ?? null,
        address: project.location?.address ?? null,
        addressBn: project.location?.addressBn ?? null,
        approval: project.approval?.number
          ? { authority: project.approval.authority ?? null, number: project.approval.number }
          : null,
      },
      unit,
      booking: {
        bookingNo: booking.bookingNo,
        bookingDate: toDhakaDate(booking.bookingDate),
        soldByName: booking.soldByName ?? null,
      },
      holder: personSnap(holder),
      coApplicants: (booking.coApplicantIds ?? []).map((id) => personSnap(people.get(String(id)))),
    },
    holder,
  };
}

const charges = (b) =>
  b.schedule.filter((i) => i.code === 'charge').reduce((s, i) => s + i.amount, 0);

function totalsOf(b, paidToDate) {
  const contract = b.price.contractTotal;
  const ch = charges(b);
  return { contract, charges: ch, paidToDate, outstanding: contract + ch - paidToDate };
}

const scheduleSnap = (items, asOf) =>
  items.map((i) => ({
    seq: i.seq,
    code: i.code,
    label: i.label,
    labelBn: i.labelBn ?? null,
    dueDate: i.dueDate ? toDhakaDate(i.dueDate) : null,
    amount: i.amount,
    ...(asOf && {
      paid: i.paid ?? 0,
      remaining: Math.max(0, i.amount - (i.paid ?? 0)),
    }),
  }));

// ── Issuers ─────────────────────────────────────────────────────────────────────

export async function issueBookingForm(org, booking, user) {
  const { snap, locale } = await base(org, booking);
  return documents.issueDocument({
    orgId: org._id,
    type: 'booking_form',
    number: booking.bookingNo,
    refId: booking._id,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      price: {
        lines: booking.price.lines.map((l) => ({
          code: l.code,
          label: l.label ?? null,
          labelBn: l.labelBn ?? null,
          amount: l.amount,
        })),
        listTotal: booking.price.listTotal,
        discount: booking.price.discount?.amount ?? 0,
        contractTotal: booking.price.contractTotal,
      },
      planName: booking.plan?.name ?? null,
      schedule: scheduleSnap(booking.schedule.filter((i) => i.code !== 'charge')),
      nominees: (booking.nominees ?? []).map((n) => ({
        name: n.name,
        relation: n.relation,
        nid: n.nid ?? null,
        sharePct: n.sharePct,
      })),
      bookingMoneyWaived: booking.bookingMoneyWaived?.reason ?? null,
    },
  });
}

/** Receipt document; queues the e-mail with the PDF when switched on and the customer has one. */
export async function issueReceiptDoc(org, booking, receipt, user, { email = true } = {}) {
  const { snap, locale, holder } = await base(org, booking);
  const entries = await accounts.ledgerOfBooking(org._id, booking._id);
  const upTo = new Date(receipt.createdAt).getTime();
  const paidToDate = entries
    .filter((e) => e.type !== 'refund' && new Date(e.createdAt).getTime() <= upTo)
    .reduce((s, e) => s + e.amount, 0);
  const items = new Map(booking.schedule.map((i) => [String(i._id), i]));
  const bank = receipt.bankAccountId
    ? (await accounts.listBankAccounts(org._id)).find((b) => b.id === String(receipt.bankAccountId))
    : null;
  const doc = await documents.issueDocument({
    orgId: org._id,
    type: 'receipt',
    number: receipt.receiptNo,
    refId: receipt._id,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      holder: {
        ...snap.holder,
        name: receipt.customerName, // as on the receipt (the holder may have changed since)
        nameBn: receipt.customerName === snap.holder?.name ? snap.holder.nameBn : null,
      },
      receipt: {
        receiptNo: receipt.receiptNo,
        date: toDhakaDate(receipt.date),
        amount: receipt.amount,
        mode: receipt.mode,
        reference: receipt.reference ?? null,
        instrumentNo: receipt.instrumentNo ?? null,
        instrumentBank: receipt.instrumentBank ?? null,
        instrumentDate: receipt.instrumentDate ? toDhakaDate(receipt.instrumentDate) : null,
        bankAccount: bank ? { bankName: bank.bankName, accountNo: bank.accountNo } : null,
        allocations: receipt.allocations.map((a) => ({
          label: a.label ?? items.get(String(a.itemId))?.label ?? a.code,
          labelBn: items.get(String(a.itemId))?.labelBn ?? null,
          amount: a.amount,
        })),
        receivedByName: receipt.receivedByName ?? null,
      },
      totals: totalsOf(booking, paidToDate),
    },
  });
  if (email && doc && holder?.email) {
    const settings = await accounts.getAccountSettings(org._id);
    if (settings.notify?.receiptEmail ?? true) {
      await enqueue({
        orgId: org._id,
        type: 'documents.emailReceipt',
        payload: { documentId: String(doc._id), to: holder.email },
        dedupeKey: `receipt-mail:${doc._id}`,
      });
    }
  }
  return doc;
}

export async function issueChequeAck(org, booking, cheque, user) {
  const { snap, locale } = await base(org, booking);
  return documents.issueDocument({
    orgId: org._id,
    type: 'cheque_ack',
    number: `${booking.bookingNo}/CQ-${cheque.chequeNo}`,
    refId: cheque._id,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      cheque: {
        chequeNo: cheque.chequeNo,
        bank: cheque.bank,
        branch: cheque.branch ?? null,
        chequeDate: toDhakaDate(cheque.chequeDate),
        amount: cheque.amount,
        receivedDate: toDhakaDate(cheque.receivedDate),
      },
    },
  });
}

export async function issueAllotmentLetter(org, booking, user) {
  const { snap, locale } = await base(org, booking);
  return documents.issueDocument({
    orgId: org._id,
    type: 'allotment_letter',
    number: `${booking.bookingNo}/AL`,
    refId: booking._id,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      allotment: { date: toDhakaDate(booking.allotment.date) },
      totals: totalsOf(booking, booking.paidTotal ?? 0),
    },
  });
}

export async function issueCancellationLetter(org, booking, user) {
  const { snap, locale } = await base(org, booking);
  const c = booking.cancellation;
  return documents.issueDocument({
    orgId: org._id,
    type: 'cancellation_letter',
    number: `${booking.bookingNo}/CN`,
    refId: booking._id,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      cancellation: {
        date: toDhakaDate(c.date),
        reason: c.reason,
        paid: c.paid,
        deductionBps: c.deductionBps ?? null,
        deduction: c.deduction,
        refundable: c.refundable,
      },
    },
  });
}

/** `entry` = the holders[] history entry just written (its _id is the document's refId). */
export async function issueTransferLetter(org, booking, entry, user) {
  const { snap, locale } = await base(org, booking);
  const people = await customers.customersByIds(org._id, [entry.customerId, entry.toCustomerId]);
  return documents.issueDocument({
    orgId: org._id,
    type: 'transfer_letter',
    number: `${booking.bookingNo}/TR-${booking.holders.length}`,
    refId: entry._id,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      transfer: {
        date: toDhakaDate(entry.until),
        from: personSnap(people.get(String(entry.customerId))),
        to: personSnap(people.get(String(entry.toCustomerId))),
        fee: entry.fee ?? 0,
        feeWaivedReason: entry.feeWaivedReason ?? null,
      },
      totals: totalsOf(booking, booking.paidTotal ?? 0),
    },
  });
}

/** A statement as of today (a new document every time — each one is a dated snapshot). */
export async function issueStatement(org, booking, user) {
  const { snap, locale } = await base(org, booking);
  const asOf = todayDhaka();
  const entries = await accounts.ledgerOfBooking(org._id, booking._id);
  const t = scheduleTotals(booking.schedule, asOf);
  return documents.issueDocument({
    orgId: org._id,
    type: 'statement',
    number: `${booking.bookingNo}/ST-${asOf.replace(/-/g, '')}`,
    refId: null,
    booking,
    locale,
    user,
    snapshot: {
      ...snap,
      asOf,
      schedule: scheduleSnap(booking.schedule, asOf).map((i, k) => ({
        ...i,
        status: itemStatus(booking.schedule[k], asOf),
      })),
      entries: entries.map((e) => ({
        date: toDhakaDate(e.date),
        type: e.type,
        ref: e.ref ?? null,
        amount: e.amount,
      })),
      refunded: -entries.filter((e) => e.type === 'refund').reduce((s, e) => s + e.amount, 0),
      totals: { total: t.total, paid: t.paid, outstanding: t.outstanding, overdue: t.overdue },
    },
  });
}

/**
 * Backfill: issue what should exist but doesn't (a crash between commit and issue). Called by
 * GET /bookings/:id/documents. Only types tied to a record are backfilled.
 */
export async function backfillDocuments(org, booking) {
  const orgId = org._id;
  const has = async (type, refId) => Boolean(await documents.findValidDocument(orgId, type, refId));
  if (booking.status === 'active' && !(await has('booking_form', booking._id))) {
    await safely('backfill booking_form', () => issueBookingForm(org, booking, null));
  }
  if (
    booking.allotment &&
    booking.status === 'active' &&
    !(await has('allotment_letter', booking._id))
  ) {
    await safely('backfill allotment', () => issueAllotmentLetter(org, booking, null));
  }
  if (booking.cancellation && !(await has('cancellation_letter', booking._id))) {
    await safely('backfill cancellation', () => issueCancellationLetter(org, booking, null));
  }
  for (const r of await accounts.receiptsOfBooking(orgId, booking._id)) {
    if (r.status === 'valid' && !(await has('receipt', r._id))) {
      await safely('backfill receipt', () =>
        issueReceiptDoc(org, booking, r, null, { email: false }),
      );
    }
  }
}

/**
 * After a manual void: issue the same paper again from today's records (the reason to void is
 * usually wrong details that staff have just corrected). Returns the new document, or null when
 * that paper no longer applies (booking cancelled, receipt reversed, cheque returned, a later
 * transfer) or is dated by nature (statements — issue a new one instead).
 */
export async function reissueDocument(org, booking, doc, user) {
  const orgId = org._id;
  const same = (a, b) => String(a) === String(b);
  switch (doc.type) {
    case 'booking_form':
      return booking.status === 'active' ? issueBookingForm(org, booking, user) : null;
    case 'allotment_letter':
      return booking.status === 'active' && booking.allotment
        ? issueAllotmentLetter(org, booking, user)
        : null;
    case 'cancellation_letter':
      return booking.cancellation ? issueCancellationLetter(org, booking, user) : null;
    case 'receipt': {
      const r = await accounts.getReceiptDoc(orgId, doc.refId).catch(() => null);
      return r?.status === 'valid' && same(r.bookingId, booking._id)
        ? issueReceiptDoc(org, booking, r, user, { email: false })
        : null;
    }
    case 'cheque_ack': {
      const c = await accounts.getChequeDoc(orgId, doc.refId).catch(() => null);
      return c && c.status !== 'returned' && same(c.bookingId, booking._id)
        ? issueChequeAck(org, booking, c, user)
        : null;
    }
    case 'transfer_letter': {
      // Only the latest transfer: its letter names the current holder and number TR-n.
      const last = booking.holders?.at(-1);
      return last && same(last._id, doc.refId)
        ? issueTransferLetter(org, booking, last, user)
        : null;
    }
    default:
      return null; // statement
  }
}
