import mongoose from 'mongoose';
import { P } from '#shared/auth/permissions.js';
import { ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { formatTaka } from '#shared/utils/money.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { audit } from '#modules/audit/audit.service.js';
import { scheduleTotals } from '#modules/accounts/allocation.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { recordReceipt } from '#modules/bookings/booking.service.js';
import { Customer } from '#modules/customers/customer.model.js';
import { diffFields } from '#shared/utils/diff.js';
import { Media } from '#modules/media/media.model.js';
import { toPublicMedia } from '#modules/media/media.service.js';
import { notifyClient, syncPortalLogin } from './portalAccount.service.js';
import { diffProfile, toProfileRequest, toSlip } from './portal.service.js';
import { PaymentSlip } from './paymentSlip.model.js';
import { ProfileRequest } from './profileRequest.model.js';

/**
 * Staff side of the portal (B5.1): the slip verification queue and contact-change requests.
 *
 * Slip approval = ONE transaction: receipt (mode `slip`, allocated oldest first, ledger) +
 * slip → approved. A second approval of the same slip finds it no longer pending and stops;
 * the receipt idempotency key `slip:<id>` makes even a retried request produce one receipt.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

const canSeeAll = (user) =>
  user.permissions.has(P.PAYMENT_SLIPS_VERIFY) || user.permissions.has(P.BOOKINGS_READ_ALL);
// Sellers without the verify permission see the slips of their own bookings (read only).
const slipScope = (user) => (canSeeAll(user) ? {} : { soldBy: oid(user.id) });

const notPending = () =>
  new ConflictError('This slip was already decided', { code: 'SLIP_NOT_PENDING' });

async function getSlipDoc(orgId, user, id) {
  const s = await PaymentSlip.findOne({ orgId, _id: id, ...slipScope(user) }).lean();
  if (!s) throw new NotFoundError('Slip not found');
  return s;
}

export async function listSlips(orgId, user, { status, bookingId, cursor, limit }) {
  const filter = { orgId, ...slipScope(user), ...cursorFilter(cursor) };
  if (status) filter.status = status;
  if (bookingId) filter.bookingId = oid(bookingId);
  const rows = await PaymentSlip.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map((s) => ({ ...toSlip(s), customerName: s.customerName })), meta };
}

/** Slip + the file + what the booking owes + anything that looks like a duplicate. */
export async function getSlip(orgId, user, id) {
  const s = await getSlipDoc(orgId, user, id);
  const [media, booking, sameFile, sameRef] = await Promise.all([
    Media.findOne({ orgId, _id: s.mediaId }).lean(),
    Booking.findOne({ orgId, _id: s.bookingId }).select('schedule status bookingNo').lean(),
    s.mediaSha256
      ? PaymentSlip.find({ orgId, mediaSha256: s.mediaSha256, _id: { $ne: s._id } })
          .select('_id status bookingNo')
          .lean()
      : [],
    s.reference
      ? PaymentSlip.find({
          orgId,
          reference: s.reference,
          _id: { $ne: s._id },
          status: { $in: ['pending', 'approved'] },
        })
          .select('_id status bookingNo')
          .lean()
      : [],
  ]);
  const totals = booking ? scheduleTotals(booking.schedule, todayDhaka()) : null;
  const ref = (x) => ({ id: String(x._id), status: x.status, bookingNo: x.bookingNo });
  return {
    ...toSlip(s),
    customerId: String(s.customerId),
    customerName: s.customerName,
    file: media ? toPublicMedia(media) : null, // private: streamed via /media/:id/file
    booking: booking
      ? { id: String(booking._id), status: booking.status, outstanding: totals.outstanding }
      : null,
    warnings: [
      ...(sameFile.length ? [{ code: 'SAME_FILE', slips: sameFile.map(ref) }] : []),
      ...(sameRef.length ? [{ code: 'SAME_REFERENCE', slips: sameRef.map(ref) }] : []),
      ...(totals && s.amount > totals.outstanding ? [{ code: 'MORE_THAN_OUTSTANDING' }] : []),
    ],
    review: s.review
      ? {
          at: s.review.at,
          byName: s.review.byName ?? null,
          reason: s.review.reason ?? null,
          note: s.review.note ?? null,
        }
      : null,
  };
}

/**
 * Approve: staff may correct the amount / date / account to what the bank statement shows.
 * The receipt date is the money date (paidOn), so the back-date window does not apply.
 */
export async function approveSlip({ org, user, id, input, ctx }) {
  const orgId = org._id;
  const s = await getSlipDoc(orgId, user, id);
  if (s.status !== 'pending') throw notPending();
  const booking = await Booking.findOne({ orgId, _id: s.bookingId }).lean();
  const amount = input.amount ?? s.amount;
  const payment = {
    amount,
    mode: 'slip',
    date: input.date ?? toDhakaDate(s.paidOn),
    bankAccountId: input.bankAccountId ?? (s.bankAccountId ? String(s.bankAccountId) : null),
    reference: input.reference ?? s.reference ?? null,
    instrumentBank: s.payerBank ?? null,
    note:
      input.note ?? `Bank slip (portal)${s.channel !== 'bank_transfer' ? ` — ${s.channel}` : ''}`,
  };
  const { receipt, replayed } = await recordReceipt({
    org,
    booking,
    payment,
    user,
    idempotencyKey: `slip:${s._id}`,
    ctx,
    checkDate: false,
    auditMeta: { slipId: String(s._id), slipAmount: s.amount },
    async inTransaction(session, r) {
      const res = await PaymentSlip.updateOne(
        { orgId, _id: s._id, status: 'pending', __v: s.__v },
        {
          $set: {
            status: 'approved',
            receiptId: r._id,
            receiptNo: r.receiptNo,
            review: {
              at: new Date(),
              by: oid(user.id),
              byName: user.name,
              note: input.note ?? null,
            },
          },
          $inc: { __v: 1 },
        },
        { session },
      );
      if (!res.modifiedCount) throw notPending();
    },
  });
  if (replayed) throw notPending();
  await audit(ctx, 'slip.approve', {
    entity: { type: 'PaymentSlip', id: s._id },
    meta: { receiptNo: receipt.receiptNo, amount, claimed: s.amount },
  });
  const customer = await Customer.findOne({ orgId, _id: s.customerId }).lean();
  if (customer) {
    const tk = formatTaka(amount, { decimals: amount % 100 !== 0 });
    const company = { bn: org.nameBn || org.name, en: org.name };
    await notifyClient({
      org,
      customer,
      bookingId: s.bookingId,
      sms: {
        bn: `${company.bn}: আপনার ৳${tk} ব্যাংক স্লিপ যাচাই হয়েছে। রসিদ নং ${receipt.receiptNo}। ধন্যবাদ।`,
        en: `${company.en}: your bank slip of Tk ${tk} is verified. Receipt no. ${receipt.receiptNo}. Thank you.`,
      },
      // The receipt e-mail (with the PDF) goes out by itself; no second e-mail here.
    });
  }
  return getSlip(orgId, user, s._id);
}

export async function rejectSlip({ org, user, id, reason, ctx }) {
  const orgId = org._id;
  const s = await getSlipDoc(orgId, user, id);
  const updated = await PaymentSlip.findOneAndUpdate(
    { orgId, _id: s._id, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        review: { at: new Date(), by: oid(user.id), byName: user.name, reason },
      },
      $inc: { __v: 1 },
    },
    { returnDocument: 'after', lean: true },
  );
  if (!updated) throw notPending();
  await audit(ctx, 'slip.reject', {
    entity: { type: 'PaymentSlip', id: s._id },
    meta: { bookingNo: s.bookingNo, amount: s.amount, reason },
  });
  const customer = await Customer.findOne({ orgId, _id: s.customerId }).lean();
  if (customer) {
    const tk = formatTaka(s.amount, { decimals: s.amount % 100 !== 0 });
    await notifyClient({
      org,
      customer,
      bookingId: s.bookingId,
      sms: {
        bn: `${org.nameBn || org.name}: আপনার ৳${tk} স্লিপটি গ্রহণ করা যায়নি — ${reason}। বিস্তারিত পোর্টালে দেখুন।`,
        en: `${org.name}: your slip of Tk ${tk} could not be accepted — ${reason}. See the portal for details.`,
      },
      email: {
        subject: { bn: 'স্লিপ গ্রহণ করা যায়নি', en: 'Bank slip not accepted' },
        lines: {
          bn: [
            `${s.bookingNo} (${s.unitCode})-এর জন্য পাঠানো ৳${tk}-এর স্লিপটি গ্রহণ করা যায়নি।`,
            `কারণ: ${reason}`,
            'প্রয়োজনে সঠিক স্লিপ আবার পাঠান বা অফিসে যোগাযোগ করুন।',
          ],
          en: [
            `The slip of Tk ${tk} you sent for ${s.bookingNo} (${s.unitCode}) could not be accepted.`,
            `Reason: ${reason}`,
            'Please send the correct slip again or contact the office.',
          ],
        },
        path: `/bookings/${s.bookingId}`,
      },
    });
  }
  return getSlip(orgId, user, s._id);
}

// ── Profile change requests ─────────────────────────────────────────────────────

export async function listProfileRequests(orgId, { status, customerId, cursor, limit }) {
  const filter = { orgId, ...cursorFilter(cursor) };
  if (status) filter.status = status;
  if (customerId) filter.customerId = oid(customerId);
  const rows = await ProfileRequest.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toProfileRequest), meta };
}

async function getRequestDoc(orgId, id) {
  const r = await ProfileRequest.findOne({ orgId, _id: id }).lean();
  if (!r) throw new NotFoundError('Request not found');
  return r;
}

export async function getProfileRequest(orgId, id) {
  const r = await getRequestDoc(orgId, id);
  const c = await Customer.findOne({ orgId, _id: r.customerId }).lean();
  // `current` lets the reviewer see if the office changed something since the request.
  const current = Object.fromEntries(Object.keys(r.changes).map((k) => [k, c?.[k] ?? null]));
  return { ...toProfileRequest(r), current };
}

const AUDITED = [
  'phone',
  'altPhone',
  'email',
  'presentAddress',
  'permanentAddress',
  'foreignAddress',
  'occupation',
  'organization',
];

export async function approveProfileRequest({ org, user, id, ctx }) {
  const orgId = org._id;
  const r = await getRequestDoc(orgId, id);
  if (r.status !== 'pending') {
    throw new ConflictError('This request was already decided', { code: 'REQUEST_NOT_PENDING' });
  }
  const doc = await Customer.findOne({ orgId, _id: r.customerId });
  if (!doc) throw new NotFoundError('Customer not found');
  // Re-validate against today's record (the office may have changed something meanwhile).
  let changes;
  try {
    ({ changes } = diffProfile(doc.toObject(), r.changes));
  } catch (err) {
    if (err.code !== 'NO_CHANGES') throw err;
    changes = {};
  }
  const claimed = await ProfileRequest.updateOne(
    { orgId, _id: r._id, status: 'pending' },
    {
      $set: { status: 'approved', review: { at: new Date(), by: oid(user.id), byName: user.name } },
    },
  );
  if (!claimed.modifiedCount) {
    throw new ConflictError('This request was already decided', { code: 'REQUEST_NOT_PENDING' });
  }
  const before = doc.toObject();
  for (const [k, v] of Object.entries(changes)) doc.set(k, v);
  await doc.save();
  const diff = diffFields(before, doc.toObject(), AUDITED);
  await audit(ctx, 'customer.update', {
    entity: { type: 'Customer', id: doc._id },
    diff,
    meta: { via: 'profile_request', requestId: String(r._id) },
  });
  await audit(ctx, 'profile_request.approve', { entity: { type: 'ProfileRequest', id: r._id } });
  const after = doc.toObject();
  await syncPortalLogin(orgId, after);
  await notifyClient({
    org,
    customer: after,
    sms: {
      bn: `${org.nameBn || org.name}: আপনার তথ্য পরিবর্তনের অনুরোধ গ্রহণ করা হয়েছে।`,
      en: `${org.name}: your request to update your details has been approved.`,
    },
  });
  return getProfileRequest(orgId, r._id);
}

export async function rejectProfileRequest({ org, user, id, reason, ctx }) {
  const orgId = org._id;
  const r = await ProfileRequest.findOneAndUpdate(
    { orgId, _id: id, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        review: { at: new Date(), by: oid(user.id), byName: user.name, reason },
      },
    },
    { returnDocument: 'after', lean: true },
  );
  if (!r) {
    await getRequestDoc(orgId, id);
    throw new ConflictError('This request was already decided', { code: 'REQUEST_NOT_PENDING' });
  }
  await audit(ctx, 'profile_request.reject', {
    entity: { type: 'ProfileRequest', id: r._id },
    meta: { reason },
  });
  const customer = await Customer.findOne({ orgId, _id: r.customerId }).lean();
  if (customer) {
    await notifyClient({
      org,
      customer,
      sms: {
        bn: `${org.nameBn || org.name}: আপনার তথ্য পরিবর্তনের অনুরোধ গ্রহণ করা যায়নি — ${reason}`,
        en: `${org.name}: your request to update your details was not approved — ${reason}`,
      },
    });
  }
  return getProfileRequest(orgId, r._id);
}
