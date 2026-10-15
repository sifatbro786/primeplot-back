import mongoose from 'mongoose';
import { getIntegrationConfig } from '#integrations/config.js';
import { AppError, ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { parseDhakaDate, toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { normalizePhone } from '#shared/utils/phone.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { audit } from '#modules/audit/audit.service.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { scheduleTotals } from '#modules/accounts/allocation.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { toScheduleItem } from '#modules/bookings/booking.service.js';
import { listUpdates } from '#modules/construction/construction.service.js';
import { Customer } from '#modules/customers/customer.model.js';
import { Document } from '#modules/documents/document.model.js';
import { toDocument } from '#modules/documents/document.service.js';
import { assertPrivateMedia, publicMediaMap } from '#modules/media/media.service.js';
import { notify } from '#modules/notifications/notification.service.js';
import { OnlinePayment } from '#modules/payments/onlinePayment.model.js';
import { toOnlinePayment } from '#modules/payments/payment.serialize.js';
import { Project } from '#modules/projects/project.model.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';
import { User } from '#modules/users/user.model.js';
import { invalidateUser } from '#modules/auth/authState.js';
import { P } from '#shared/auth/permissions.js';
import { PaymentSlip } from './paymentSlip.model.js';
import { PROFILE_FIELDS, ProfileRequest } from './profileRequest.model.js';

/**
 * Customer portal — what a signed-in client sees and does (B5.1).
 *
 * A client sees every booking where their customer is the holder or a co-applicant (the holder
 * may pay and upload slips; a co-applicant may too — they are joint buyers). After a transfer
 * the old holder simply stops matching. Documents issued before the current holder took over
 * (old booking form, letters with the previous holder's NID) are not shown; receipts are,
 * because the money paid stays with the unit.
 *
 * Anything that is not theirs answers 404, exactly like a missing id.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const notFound = (what = 'Booking') => new NotFoundError(`${what} not found`);
const unprocessable = (message, code, details) =>
  new AppError(message, { statusCode: 422, code, details });

// ── Who is this client? ────────────────────────────────────────────────────────

/** The customer behind a client login, or 404 PORTAL_NOT_LINKED. */
export async function portalCustomer(orgId, user) {
  const c = await Customer.findOne({ orgId, portalUserId: oid(user.id) }).lean();
  if (!c) {
    throw new NotFoundError('This login is not linked to a customer', {
      code: 'PORTAL_NOT_LINKED',
    });
  }
  return c;
}

const mine = (c) => ({ $or: [{ customerId: c._id }, { coApplicantIds: c._id }] });

/** Booking this customer is on (lean), or 404. */
export async function myBooking(orgId, c, id, { session } = {}) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const b = await Booking.findOne({ orgId, _id: id, ...mine(c) })
    .session(session ?? null)
    .lean();
  if (!b) throw notFound();
  return b;
}

/** When the current holder took over (last transfer) — earlier papers are not theirs. */
const holderSince = (b) => (b.holders?.length ? new Date(b.holders.at(-1).until) : null);

export function toPortalProfile(c) {
  return {
    id: String(c._id),
    customerNo: c.customerNo,
    name: c.name,
    nameBn: c.nameBn ?? null,
    phone: c.phone,
    altPhone: c.altPhone ?? null,
    email: c.email ?? null,
    presentAddress: c.presentAddress ?? null,
    permanentAddress: c.permanentAddress ?? null,
    foreignAddress: c.foreignAddress ?? null,
    occupation: c.occupation ?? null,
    organization: c.organization ?? null,
    locale: c.locale ?? null,
    // Shown, not editable here (deed papers): changed at the office.
    nid: c.nid ? `•••• ${c.nid.slice(-4)}` : null,
    passportNo: c.passportNo ? `•••• ${c.passportNo.slice(-4)}` : null,
  };
}

/** What the portal can offer (buttons are hidden when off). */
export async function portalFeatures(orgId) {
  const s = accounts.portalSettingsOf(await accounts.getAccountSettings(orgId));
  return {
    onlinePayment: getIntegrationConfig(orgId, 'payment').enabled && s.onlinePayment,
    onlineMinAmount: s.onlineMinAmount,
    slipUpload: s.slipUpload,
  };
}

export async function getMe(org, user) {
  const c = await portalCustomer(org._id, user);
  const [pending, features, bankAccounts] = await Promise.all([
    ProfileRequest.findOne({ orgId: org._id, customerId: c._id, status: 'pending' }).lean(),
    portalFeatures(org._id),
    accounts.listBankAccounts(org._id, { active: true }),
  ]);
  return {
    profile: toPortalProfile(c),
    pendingProfileRequest: pending ? toProfileRequest(pending) : null,
    features,
    // Where to pay by bank transfer / deposit (shown with the slip form).
    bankAccounts: bankAccounts.map((b) => ({
      id: b.id,
      name: b.name,
      bankName: b.bankName,
      branch: b.branch ?? null,
      accountName: b.accountName ?? null,
      accountNo: b.accountNo,
      routingNo: b.routingNo ?? null,
    })),
    company: {
      name: org.name,
      nameBn: org.nameBn ?? null,
      phone: org.phone ?? null,
      email: org.email ?? null,
      address: org.address ?? null,
      addressBn: org.addressBn ?? null,
    },
  };
}

/** Client changes the language of their SMS / e-mails (applied at once — not a deed detail). */
export async function setLocale({ org, user, locale, ctx }) {
  const c = await portalCustomer(org._id, user);
  await Customer.updateOne({ orgId: org._id, _id: c._id }, { $set: { locale } });
  // The login's UI language follows (one setting for the client, not two).
  await User.updateOne({ orgId: org._id, _id: user.id }, { $set: { locale } });
  invalidateUser(user.id);
  await audit(ctx, 'portal.locale', { entity: { type: 'Customer', id: c._id }, meta: { locale } });
}

// ── Bookings ────────────────────────────────────────────────────────────────────

async function projectCards(orgId, ids) {
  const rows = await Project.find({ orgId, _id: { $in: [...new Set(ids.map(String))] } })
    .select('name nameBn slug kind code coverMediaId handoverAt address location')
    .setOptions({ withDeleted: true })
    .lean();
  const media = await publicMediaMap(
    orgId,
    rows.map((p) => p.coverMediaId),
  );
  return new Map(
    rows.map((p) => [
      String(p._id),
      {
        id: String(p._id),
        name: p.name,
        nameBn: p.nameBn ?? null,
        slug: p.slug,
        kind: p.kind,
        code: p.code ?? null,
        handoverAt: p.handoverAt ? toDhakaDate(p.handoverAt) : null,
        cover: p.coverMediaId ? (media.get(String(p.coverMediaId)) ?? null) : null,
      },
    ]),
  );
}

function toPortalBookingSummary(b, c, projects, asOf) {
  const t = scheduleTotals(b.schedule, asOf);
  return {
    id: String(b._id),
    bookingNo: b.bookingNo,
    project: projects.get(String(b.projectId)) ?? { id: String(b.projectId) },
    unitCode: b.unitCode,
    kind: b.kind,
    role: String(b.customerId) === String(c._id) ? 'holder' : 'co_applicant',
    holderName: b.customerName,
    bookingDate: toDhakaDate(b.bookingDate),
    status: b.status,
    stage: b.stage ?? 'booked',
    contractTotal: b.price.contractTotal,
    totals: {
      ...t,
      nextDue: t.nextDue && { ...t.nextDue, dueDate: toDhakaDate(t.nextDue.dueDate) },
    },
  };
}

export async function listMyBookings(org, user) {
  const c = await portalCustomer(org._id, user);
  const rows = await Booking.find({ orgId: org._id, ...mine(c) })
    .sort({ status: 1, bookingDate: -1 })
    .lean();
  const projects = await projectCards(
    org._id,
    rows.map((b) => b.projectId),
  );
  const asOf = todayDhaka();
  return rows.map((b) => toPortalBookingSummary(b, c, projects, asOf));
}

const PORTAL_RECEIPT = (r) => ({
  id: String(r.id),
  receiptNo: r.receiptNo,
  date: r.date,
  amount: r.amount,
  mode: r.mode,
  reference: r.reference ?? null,
  status: r.status,
});

export async function getMyBooking(org, user, id) {
  const orgId = org._id;
  const c = await portalCustomer(orgId, user);
  const b = await myBooking(orgId, c, id);
  const asOf = todayDhaka();
  const since = holderSince(b);
  const [projects, receiptRows, docRows, slips, payments, features, updates] = await Promise.all([
    projectCards(orgId, [b.projectId]),
    accounts.receiptsOfBooking(orgId, b._id),
    Document.find({
      orgId,
      bookingId: b._id,
      status: 'valid',
      ...(since && { createdAt: { $gte: since } }),
    })
      .sort({ createdAt: -1 })
      .lean(),
    PaymentSlip.find({ orgId, bookingId: b._id, status: { $in: ['pending', 'rejected'] } })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
    OnlinePayment.find({ orgId, bookingId: b._id, status: { $in: ['initiated', 'review'] } })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    portalFeatures(orgId),
    listUpdates(orgId, b.projectId, { published: 'true', limit: 3 }).catch(() => ({ items: [] })),
  ]);
  const receipts = await accounts.serializeReceipts(orgId, receiptRows);
  const active = b.status === 'active';
  const outstanding = scheduleTotals(b.schedule, asOf).outstanding;
  return {
    ...toPortalBookingSummary(b, c, projects, asOf),
    price: {
      listTotal: b.price.listTotal,
      discount: b.price.discount?.amount ?? 0,
      contractTotal: b.price.contractTotal,
    },
    planName: b.plan?.name ?? null,
    schedule: b.schedule.map((i) => toScheduleItem(i, asOf)),
    receipts: receipts.map(PORTAL_RECEIPT),
    documents: docRows.map(toDocument).map((d) => ({
      id: d.id,
      type: d.type,
      number: d.number,
      date: d.date,
      locale: d.locale,
      verifyUrl: d.verifyUrl,
    })),
    slips: slips.map(toSlip),
    onlinePayments: payments.map(toOnlinePayment),
    allotment: b.allotment ? { date: toDhakaDate(b.allotment.date) } : null,
    registration: b.registration
      ? { date: toDhakaDate(b.registration.date), deedNo: b.registration.deedNo }
      : null,
    handover: b.handover ? { date: toDhakaDate(b.handover.date) } : null,
    cancellation: b.cancellation
      ? {
          date: toDhakaDate(b.cancellation.date),
          paid: b.cancellation.paid,
          deduction: b.cancellation.deduction,
          refundable: b.cancellation.refundable,
          refunded: b.cancellation.refunded ?? 0,
        }
      : null,
    constructionUpdates: updates.items ?? [],
    canPayOnline: active && outstanding > 0 && features.onlinePayment,
    canUploadSlip: active && outstanding > 0 && features.slipUpload,
  };
}

/** Every unpaid item due within `days` (default 60) or overdue, across the client's bookings. */
export async function myDues(org, user, { days = 60 } = {}) {
  const c = await portalCustomer(org._id, user);
  const rows = await Booking.find({ orgId: org._id, status: 'active', ...mine(c) }).lean();
  const asOf = todayDhaka();
  const until = Date.parse(`${asOf}T00:00:00+06:00`) + days * 86_400_000;
  const projects = await projectCards(
    org._id,
    rows.map((b) => b.projectId),
  );
  const items = [];
  let overdue = 0;
  let dueNow = 0;
  for (const b of rows) {
    const t = scheduleTotals(b.schedule, asOf);
    overdue += t.overdue;
    dueNow += t.dueNow;
    for (const i of b.schedule) {
      const s = toScheduleItem(i, asOf);
      if (!s.remaining || !i.dueDate || new Date(i.dueDate).getTime() > until) continue;
      items.push({
        bookingId: String(b._id),
        bookingNo: b.bookingNo,
        unitCode: b.unitCode,
        project: projects.get(String(b.projectId)) ?? { id: String(b.projectId) },
        ...s,
      });
    }
  }
  items.sort((x, y) => x.dueDate.localeCompare(y.dueDate) || x.seq - y.seq);
  return { asOf, totals: { overdue, dueNow }, items };
}

// ── Documents ───────────────────────────────────────────────────────────────────

/** A valid document of one of the client's bookings (issued since they became holder). */
export async function myDocument(orgId, user, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Document');
  const c = await portalCustomer(orgId, user);
  const d = await Document.findOne({ orgId, _id: id, status: 'valid' }).lean();
  if (!d) throw notFound('Document');
  const b = await Booking.findOne({ orgId, _id: d.bookingId, ...mine(c) }).lean();
  if (!b) throw notFound('Document');
  const since = holderSince(b);
  if (since && d.createdAt < since) throw notFound('Document');
  return d;
}

// ── Payment slips ───────────────────────────────────────────────────────────────

export function toSlip(s) {
  return {
    id: String(s._id),
    bookingId: String(s.bookingId),
    bookingNo: s.bookingNo,
    unitCode: s.unitCode,
    amount: s.amount,
    paidOn: toDhakaDate(s.paidOn),
    channel: s.channel,
    bankAccountId: s.bankAccountId ? String(s.bankAccountId) : null,
    reference: s.reference ?? null,
    payerBank: s.payerBank ?? null,
    mediaId: String(s.mediaId),
    note: s.note ?? null,
    status: s.status,
    rejectReason: s.status === 'rejected' ? (s.review?.reason ?? null) : null,
    reviewedAt: s.review?.at ?? null,
    receipt: s.receiptId ? { id: String(s.receiptId), receiptNo: s.receiptNo } : null,
    createdAt: s.createdAt,
  };
}

/** Pending slips count as "already paid" when checking a new slip/online amount. */
export async function pendingSlipTotal(orgId, bookingId) {
  const [r] = await PaymentSlip.aggregate([
    { $match: { orgId: oid(orgId), bookingId: oid(bookingId), status: 'pending' } },
    { $group: { _id: null, amount: { $sum: '$amount' } } },
  ]);
  return r?.amount ?? 0;
}

const MAX_PENDING_SLIPS = 5;

export async function submitSlip({ org, user, bookingId, input, ctx }) {
  const orgId = org._id;
  const c = await portalCustomer(orgId, user);
  const b = await myBooking(orgId, c, bookingId);
  const features = await portalFeatures(orgId);
  if (!features.slipUpload) {
    throw new ConflictError('Slip upload is switched off — please contact the office', {
      code: 'SLIPS_DISABLED',
    });
  }
  if (b.status !== 'active') {
    throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
  }
  const today = todayDhaka();
  if (input.paidOn > today) {
    throw unprocessable('The payment date is in the future', 'SLIP_DATE_FUTURE', [
      { path: 'paidOn', message: 'In the future' },
    ]);
  }
  if (input.paidOn < toDhakaDate(b.bookingDate)) {
    throw unprocessable('The payment date is before the booking', 'SLIP_BEFORE_BOOKING', [
      { path: 'paidOn', message: 'Before the booking date' },
    ]);
  }
  const outstanding = scheduleTotals(b.schedule, today).outstanding;
  const pending = await pendingSlipTotal(orgId, b._id);
  if (input.amount > outstanding - pending) {
    throw unprocessable('This is more than what is left to pay', 'OVERPAYMENT', {
      outstanding,
      pendingSlips: pending,
    });
  }
  const pendingCount = await PaymentSlip.countDocuments({
    orgId,
    customerId: c._id,
    status: 'pending',
  });
  if (pendingCount >= MAX_PENDING_SLIPS) {
    throw new ConflictError('Please wait until your earlier slips are checked', {
      code: 'TOO_MANY_PENDING_SLIPS',
    });
  }
  if (input.bankAccountId) await accounts.assertActiveBankAccount(orgId, input.bankAccountId);

  // The file must be this client's own private slip upload.
  const media = (await assertPrivateMedia(orgId, [input.mediaId])).get(input.mediaId);
  if (String(media.uploadedBy) !== user.id || media.purpose !== 'payment_slip') {
    throw unprocessable('Upload the slip first (as a payment slip)', 'INVALID_MEDIA', [
      { path: 'mediaId', message: 'Not your slip upload' },
    ]);
  }
  const used = await PaymentSlip.exists({ orgId, mediaId: media._id });
  if (used) {
    throw new ConflictError('This file was already sent with another slip', {
      code: 'SLIP_FILE_REUSED',
    });
  }

  const slip = await PaymentSlip.create({
    orgId,
    bookingId: b._id,
    bookingNo: b.bookingNo,
    projectId: b.projectId,
    unitCode: b.unitCode,
    customerId: c._id,
    customerName: c.name,
    soldBy: b.soldBy ?? null,
    submittedBy: oid(user.id),
    amount: input.amount,
    paidOn: parseDhakaDate(input.paidOn),
    channel: input.channel,
    bankAccountId: input.bankAccountId ? oid(input.bankAccountId) : null,
    reference: input.reference ?? null,
    payerBank: input.payerBank ?? null,
    mediaId: media._id,
    mediaSha256: media.sha256 ?? null,
    note: input.note ?? null,
  });
  await audit(ctx, 'slip.submit', {
    entity: { type: 'PaymentSlip', id: slip._id },
    meta: { bookingNo: b.bookingNo, amount: slip.amount, channel: slip.channel },
  });
  const verifiers = await listActiveStaffWith(orgId, P.PAYMENT_SLIPS_VERIFY);
  await notify(orgId, [...verifiers.map((u) => u.id), b.soldBy], 'payment_slip.submitted', {
    slipId: String(slip._id),
    bookingId: String(b._id),
    bookingNo: b.bookingNo,
    unitCode: b.unitCode,
    customerName: c.name,
    amount: slip.amount,
  });
  return toSlip(slip.toObject());
}

export async function listMySlips(org, user, { status, cursor, limit }) {
  const c = await portalCustomer(org._id, user);
  const filter = { orgId: org._id, customerId: c._id, ...cursorFilter(cursor) };
  if (status) filter.status = status;
  const rows = await PaymentSlip.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toSlip), meta };
}

export async function withdrawSlip({ org, user, id, ctx }) {
  const c = await portalCustomer(org._id, user);
  if (!mongoose.isValidObjectId(id)) throw notFound('Slip');
  const s = await PaymentSlip.findOneAndUpdate(
    { orgId: org._id, _id: id, customerId: c._id, status: 'pending' },
    { $set: { status: 'withdrawn', review: { at: new Date(), by: oid(user.id), byName: c.name } } },
    { returnDocument: 'after', lean: true },
  );
  if (!s) {
    const exists = await PaymentSlip.exists({ orgId: org._id, _id: id, customerId: c._id });
    if (!exists) throw notFound('Slip');
    throw new ConflictError('This slip was already checked', { code: 'SLIP_NOT_PENDING' });
  }
  await audit(ctx, 'slip.withdraw', { entity: { type: 'PaymentSlip', id: s._id } });
  return toSlip(s);
}

// ── Profile change requests ─────────────────────────────────────────────────────

export function toProfileRequest(r) {
  return {
    id: String(r._id),
    customerId: String(r.customerId),
    customerName: r.customerName,
    changes: r.changes,
    before: r.before,
    note: r.note ?? null,
    status: r.status,
    rejectReason: r.status === 'rejected' ? (r.review?.reason ?? null) : null,
    reviewedAt: r.review?.at ?? null,
    reviewedBy: r.review?.byName ?? null,
    createdAt: r.createdAt,
  };
}

/** Normalise + keep only real changes. Throws 422 for a bad phone, 409 when nothing changes. */
export function diffProfile(c, input) {
  const changes = {};
  const before = {};
  for (const k of PROFILE_FIELDS) {
    if (input[k] === undefined) continue;
    let v = input[k] === '' ? null : input[k];
    if ((k === 'phone' || k === 'altPhone') && v !== null) {
      const e164 = normalizePhone(v);
      if (!e164) {
        throw unprocessable('Invalid phone number', 'INVALID_PHONE', [
          { path: k, message: 'Enter a Bangladesh mobile or +country code number' },
        ]);
      }
      v = e164;
    }
    if (k === 'phone' && v === null) {
      throw unprocessable('A phone number is required', 'PHONE_REQUIRED', [
        { path: 'phone', message: 'Required' },
      ]);
    }
    if (k === 'email' && v) v = v.toLowerCase();
    if ((c[k] ?? null) === v) continue;
    changes[k] = v;
    before[k] = c[k] ?? null;
  }
  if (!Object.keys(changes).length) {
    throw new ConflictError('Nothing would change', { code: 'NO_CHANGES' });
  }
  return { changes, before };
}

export async function submitProfileRequest({ org, user, input, ctx }) {
  const orgId = org._id;
  const c = await portalCustomer(orgId, user);
  const { note, ...fields } = input;
  const { changes, before } = diffProfile(c, fields);
  let r;
  try {
    r = await ProfileRequest.create({
      orgId,
      customerId: c._id,
      customerName: c.name,
      submittedBy: oid(user.id),
      changes,
      before,
      note: note ?? null,
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new ConflictError('You already have a request waiting — withdraw it to change it', {
        code: 'PROFILE_REQUEST_PENDING',
      });
    }
    throw err;
  }
  await audit(ctx, 'profile_request.submit', {
    entity: { type: 'ProfileRequest', id: r._id },
    meta: { customerNo: c.customerNo, fields: Object.keys(changes) },
  });
  const managers = await listActiveStaffWith(orgId, P.PORTAL_MANAGE);
  await notify(
    orgId,
    managers.map((u) => u.id),
    'profile_request.submitted',
    {
      requestId: String(r._id),
      customerId: String(c._id),
      customerName: c.name,
      fields: Object.keys(changes),
    },
  );
  return toProfileRequest(r.toObject());
}

export async function withdrawProfileRequest({ org, user, id, ctx }) {
  const c = await portalCustomer(org._id, user);
  if (!mongoose.isValidObjectId(id)) throw notFound('Request');
  const r = await ProfileRequest.findOneAndUpdate(
    { orgId: org._id, _id: id, customerId: c._id, status: 'pending' },
    { $set: { status: 'withdrawn', review: { at: new Date(), by: oid(user.id), byName: c.name } } },
    { returnDocument: 'after', lean: true },
  );
  if (!r) throw notFound('Request');
  await audit(ctx, 'profile_request.withdraw', { entity: { type: 'ProfileRequest', id: r._id } });
  return toProfileRequest(r);
}

export async function listMyProfileRequests(org, user) {
  const c = await portalCustomer(org._id, user);
  const rows = await ProfileRequest.find({ orgId: org._id, customerId: c._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  return rows.map(toProfileRequest);
}
