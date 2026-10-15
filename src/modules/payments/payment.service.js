import mongoose from 'mongoose';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { getIntegrationConfig } from '#integrations/config.js';
import * as sslcz from '#integrations/payments/sslcommerz.js';
import { P } from '#shared/auth/permissions.js';
import { AppError, ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { formatTaka } from '#shared/utils/money.js';
import { todayDhaka } from '#shared/utils/dhakaDate.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { audit, SYSTEM_ACTOR } from '#modules/audit/audit.service.js';
import { scheduleTotals } from '#modules/accounts/allocation.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { recordReceipt } from '#modules/bookings/booking.service.js';
import { Customer } from '#modules/customers/customer.model.js';
import { notify } from '#modules/notifications/notification.service.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { notifyClient } from '#modules/portal/portalAccount.service.js';
import {
  myBooking,
  pendingSlipTotal,
  portalCustomer,
  portalFeatures,
} from '#modules/portal/portal.service.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';
import { OnlinePayment, OPEN_ONLINE_STATUSES } from './onlinePayment.model.js';
import { toOnlinePayment, toStaffOnlinePayment } from './payment.serialize.js';

/**
 * SSLCommerz online payments (B5.2, ARCHITECTURE §6.5).
 *
 *   client → POST /portal/bookings/:id/pay → session → redirect to SSLCommerz
 *   SSLCommerz → browser POST success/fail/cancel (→ redirect back to the portal)
 *              → server POST IPN
 *   either trigger → Order Validation API (val_id) → checks → ONE receipt (mode `online`)
 *   reconcile job → Transaction Query API for attempts that never came back
 *
 * Exactly-once: the receipt's idempotency key is `sslcz:<tranId>` (unique index), so the IPN,
 * the success redirect, the reconcile job and a staff approval can all race — one receipt.
 * Nothing the browser or the IPN body says is trusted except as a pointer to validate.
 */
const log = logger.child({ module: 'payments' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const unprocessable = (message, code, details) =>
  new AppError(message, { statusCode: 422, code, details });

const MAX_EVENTS = 30;
const OPEN_ATTEMPTS_PER_BOOKING = 3; // unfinished sessions at once (stops click-spam)
export const RECONCILE_AFTER_MS = 15 * 60_000; // let the IPN arrive first
export const RECONCILE_RECHECK_MS = 10 * 60_000;
export const EXPIRE_AFTER_MS = 3 * 3_600_000; // never came back → expired
export const RECONCILE_WINDOW_MS = 72 * 3_600_000;

const receiptKey = (tranId) => `sslcz:${tranId}`;
export const newTranId = () => `PP${new ObjectId().toHexString().toUpperCase()}`; // 26 chars

export const callbackUrls = () => {
  const base = `${env.apiUrl}/api/v1/webhooks/sslcommerz`;
  return {
    success: `${base}/success`,
    fail: `${base}/fail`,
    cancel: `${base}/cancel`,
    ipn: `${base}/ipn`,
  };
};

/** Where the browser lands after SSLCommerz (the portal's payment result page). */
export function returnUrl(payment, result) {
  const locale = payment?.locale === 'en' ? 'en' : 'bn';
  const base = `${env.CLIENT_URL.replace(/\/+$/, '')}/${locale}/portal`;
  return payment ? `${base}/payments/${payment._id}?result=${result}` : base;
}

const event = (source, status = null, note = null) => ({
  $push: {
    events: {
      $each: [{ at: new Date(), source, status, note: note?.slice(0, 300) ?? null }],
      $slice: -MAX_EVENTS,
    },
  },
});

async function orgOf(orgId) {
  const org = await Organization.findOne({ _id: orgId }).lean();
  if (!org) throw new NotFoundError('Organization not found');
  return org;
}

// ── Start (portal) ──────────────────────────────────────────────────────────────

/**
 * POST /portal/bookings/:id/pay { amount } → { payment, redirectUrl }.
 * `Idempotency-Key` returns the same session for a double click.
 */
export async function startPayment({ org, user, bookingId, amount, idempotencyKey, ctx }) {
  const orgId = org._id;
  if (idempotencyKey) {
    const prior = await OnlinePayment.findOne({ orgId, idempotencyKey }).lean();
    if (prior) {
      if (String(prior.userId) !== user.id || String(prior.bookingId) !== String(bookingId)) {
        throw new ConflictError('This Idempotency-Key was already used', {
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      return {
        payment: toOnlinePayment(prior),
        redirectUrl: prior.status === 'initiated' ? prior.gateway?.gatewayUrl : null,
        replayed: true,
      };
    }
  }
  const features = await portalFeatures(orgId);
  if (!features.onlinePayment) {
    throw new ConflictError('Online payment is not available', { code: 'PAYMENT_DISABLED' });
  }
  const c = await portalCustomer(orgId, user);
  const b = await myBooking(orgId, c, bookingId);
  if (b.status !== 'active') {
    throw new ConflictError('This booking is not active', { code: 'BOOKING_NOT_ACTIVE' });
  }
  const outstanding = scheduleTotals(b.schedule, todayDhaka()).outstanding;
  const payable = outstanding - (await pendingSlipTotal(orgId, b._id));
  if (payable <= 0) {
    throw unprocessable('Nothing is left to pay online', 'NOTHING_TO_PAY', {
      outstanding,
      payable: 0,
    });
  }
  const min = Math.min(features.onlineMinAmount, payable);
  if (amount < min || amount > payable) {
    throw unprocessable(
      amount > payable
        ? 'This is more than what is left to pay'
        : 'The amount is below the minimum',
      amount > payable ? 'OVERPAYMENT' : 'AMOUNT_TOO_SMALL',
      { min, max: payable, outstanding },
    );
  }
  const open = await OnlinePayment.countDocuments({
    orgId,
    bookingId: b._id,
    status: 'initiated',
    createdAt: { $gt: new Date(Date.now() - 30 * 60_000) },
  });
  if (open >= OPEN_ATTEMPTS_PER_BOOKING) {
    throw new ConflictError('Please finish or wait for your earlier payment attempt', {
      code: 'TOO_MANY_OPEN_PAYMENTS',
    });
  }

  const tranId = newTranId();
  let doc;
  try {
    doc = await OnlinePayment.create({
      orgId,
      tranId,
      bookingId: b._id,
      bookingNo: b.bookingNo,
      projectId: b.projectId,
      unitCode: b.unitCode,
      customerId: c._id,
      customerName: c.name,
      userId: oid(user.id),
      soldBy: b.soldBy ?? null,
      locale: (c.locale ?? user.locale) === 'en' ? 'en' : 'bn',
      amount,
      idempotencyKey: idempotencyKey ?? null,
      events: [{ at: new Date(), source: 'init', status: 'CREATED' }],
    });
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.idempotencyKey) {
      return startPayment({ org, user, bookingId, amount, idempotencyKey, ctx });
    }
    throw err;
  }

  let session;
  try {
    session = await sslcz.initSession(orgId, {
      tranId,
      amount,
      urls: callbackUrls(),
      customer: {
        name: c.name,
        // SSLCommerz requires an e-mail; a phone-only buyer gets the company's.
        email: c.email || org.email || `no-reply@${new URL(env.CLIENT_URL).hostname}`,
        phone: c.phone,
        address: c.presentAddress ?? c.permanentAddress ?? null,
      },
      product: { name: `${b.bookingNo} — ${b.unitCode} installment`, category: 'Real Estate' },
      values: { value_a: String(b._id), value_b: b.bookingNo, value_c: String(c._id) },
    });
  } catch (err) {
    await OnlinePayment.updateOne(
      { orgId, _id: doc._id },
      { $set: { status: 'failed' }, ...event('init', 'SESSION_FAILED', err.message) },
    );
    log.warn({ tranId, code: err.code, msg: err.message }, 'SSLCommerz session failed');
    throw new AppError('The payment gateway is not responding — please try again shortly', {
      statusCode: 502,
      code: 'GATEWAY_ERROR',
    });
  }
  const saved = await OnlinePayment.findOneAndUpdate(
    { orgId, _id: doc._id },
    {
      $set: { 'gateway.sessionKey': session.sessionKey, 'gateway.gatewayUrl': session.gatewayUrl },
      ...event('init', 'SESSION'),
    },
    { returnDocument: 'after', lean: true },
  );
  await audit(ctx, 'online_payment.start', {
    entity: { type: 'OnlinePayment', id: doc._id },
    meta: { tranId, bookingNo: b.bookingNo, amount },
  });
  return { payment: toOnlinePayment(saved), redirectUrl: session.gatewayUrl, replayed: false };
}

// ── Callbacks / IPN ─────────────────────────────────────────────────────────────

const TRAN_RE = /^PP[0-9A-F]{24}$/;
// Shape check only (no operators / huge strings); the Validation API decides what is real.
const VAL_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function findByTranId(tranId) {
  if (!TRAN_RE.test(String(tranId ?? ''))) return null;
  return OnlinePayment.findOne({ tranId }).setOptions({ skipTenant: true }).lean();
}

/**
 * success / fail / cancel (browser) and ipn (server). Returns the payment (lean, fresh) or null
 * for an unknown tran_id. Never throws for gateway trouble — the reconcile job will retry.
 */
export async function handleCallback(kind, body) {
  const payment = await findByTranId(body?.tran_id);
  if (!payment) {
    log.warn(
      { kind, tranId: String(body?.tran_id ?? '').slice(0, 40) },
      'SSLCommerz callback for an unknown tran_id',
    );
    return null;
  }
  const orgId = payment.orgId;
  const gwStatus =
    String(body?.status ?? '')
      .toUpperCase()
      .slice(0, 40) || null;
  const signed = sslcz.verifySignature(orgId, body);
  if (body?.verify_sign && !signed)
    log.warn({ kind, tranId: payment.tranId }, 'SSLCommerz signature mismatch');
  await OnlinePayment.updateOne(
    { orgId, _id: payment._id },
    event(kind, gwStatus, body?.verify_sign ? (signed ? 'signed' : 'BAD SIGNATURE') : null),
  );

  const valId = typeof body?.val_id === 'string' && VAL_RE.test(body.val_id) ? body.val_id : null;
  const claimsPaid = valId && (kind === 'success' || ['VALID', 'VALIDATED'].includes(gwStatus));
  try {
    if (claimsPaid) await settleWithValidation(payment, valId, kind);
    else if (
      ['fail', 'cancel'].includes(kind) ||
      ['FAILED', 'CANCELLED', 'EXPIRED', 'UNATTEMPTED'].includes(gwStatus)
    ) {
      const to =
        kind === 'cancel' || gwStatus === 'CANCELLED'
          ? 'cancelled'
          : gwStatus === 'EXPIRED'
            ? 'expired'
            : 'failed';
      // Only an unfinished attempt closes; a later VALID validation can still re-open it.
      await OnlinePayment.updateOne(
        { orgId, _id: payment._id, status: 'initiated' },
        { $set: { status: to } },
      );
    }
  } catch (err) {
    log.warn(
      { kind, tranId: payment.tranId, code: err.code, msg: err.message },
      'SSLCommerz settle failed (reconcile will retry)',
    );
  }
  return OnlinePayment.findOne({ orgId, _id: payment._id }).lean();
}

/**
 * Ask SSLCommerz about `valId` and act on the answer. Safe to call any number of times.
 * Returns the resulting status.
 */
export async function settleWithValidation(payment, valId, source) {
  const orgId = payment.orgId;
  if (payment.status === 'paid' || payment.status === 'rejected') return payment.status;
  const v = await sslcz.validate(orgId, valId);
  const set = {
    'gateway.valId': valId,
    'gateway.validationStatus': v.status || null,
    'gateway.validatedAt': new Date(),
    'gateway.validatedAmount': v.currencyAmount ?? v.amount,
    'gateway.bankTranId': v.bankTranId,
    'gateway.cardType': v.cardType,
    'gateway.cardBrand': v.cardBrand,
    'gateway.cardIssuer': v.cardIssuer,
    'gateway.riskLevel': Number.isFinite(v.riskLevel) ? v.riskLevel : null,
    'gateway.riskTitle': v.riskTitle,
    'gateway.tranDate': v.tranDate,
    lastCheckedAt: new Date(),
  };
  if (!['VALID', 'VALIDATED'].includes(v.status)) {
    await OnlinePayment.updateOne(
      { orgId, _id: payment._id },
      { $set: set, ...event(source, `VALIDATION_${v.status || 'EMPTY'}`) },
    );
    return payment.status;
  }
  await OnlinePayment.updateOne(
    { orgId, _id: payment._id },
    { $set: set, ...event(source, `VALIDATION_${v.status}`) },
  );

  // Same transaction, same amount, in taka — anything else is a person's job.
  const amountOk =
    v.tranId === payment.tranId &&
    (v.currencyType ?? v.currency) === 'BDT' &&
    (v.currencyAmount ?? v.amount) === payment.amount;
  if (!amountOk) return holdForReview(payment, 'AMOUNT_MISMATCH', source);
  if (v.riskLevel === 1) return holdForReview(payment, 'RISK', source);
  return postReceipt(payment, { source, tranDate: v.tranDate });
}

async function holdForReview(payment, reason, source) {
  const orgId = payment.orgId;
  const res = await OnlinePayment.updateOne(
    { orgId, _id: payment._id, status: { $in: OPEN_ONLINE_STATUSES } },
    { $set: { status: 'review', reviewReason: reason }, ...event(source, 'REVIEW', reason) },
  );
  if (res.modifiedCount) {
    const reviewers = await listActiveStaffWith(orgId, P.ONLINE_PAYMENTS_REVIEW);
    await notify(
      orgId,
      reviewers.map((u) => u.id),
      'online_payment.review',
      {
        paymentId: String(payment._id),
        bookingId: String(payment.bookingId),
        bookingNo: payment.bookingNo,
        customerName: payment.customerName,
        amount: payment.amount,
        reason,
      },
    );
    log.warn({ tranId: payment.tranId, reason }, 'Online payment held for review');
  }
  return 'review';
}

/**
 * Write the receipt (or link the one that already exists) and mark the payment paid.
 * `by` = staff user approving a held payment; null = automatic.
 */
async function postReceipt(
  payment,
  { source, tranDate, by = null, note = null, fromReview = false },
) {
  const orgId = payment.orgId;
  const org = await orgOf(orgId);
  const booking = await Booking.findOne({ orgId, _id: payment.bookingId }).lean();
  const date = /^\d{4}-\d{2}-\d{2}/.test(tranDate ?? '') ? tranDate.slice(0, 10) : todayDhaka();
  const fresh = await OnlinePayment.findOne({ orgId, _id: payment._id }).lean();
  const allowed = fromReview ? ['review'] : OPEN_ONLINE_STATUSES;
  if (fresh.status === 'paid') return 'paid';
  if (!allowed.includes(fresh.status)) return fresh.status;

  const ctx = by
    ? { orgId, actor: { id: by.id, name: by.name, role: by.role, kind: 'user' } }
    : { orgId, actor: SYSTEM_ACTOR };
  let receipt;
  try {
    const r = await recordReceipt({
      org,
      booking,
      payment: {
        amount: fresh.amount,
        mode: 'online',
        date: date > todayDhaka() ? todayDhaka() : date,
        reference: fresh.gateway?.bankTranId ?? fresh.tranId,
        instrumentNo: fresh.tranId,
        instrumentBank:
          [fresh.gateway?.cardType, fresh.gateway?.cardIssuer]
            .filter(Boolean)
            .join(' — ')
            .slice(0, 120) || null,
        note: note ?? `SSLCommerz ${fresh.tranId}`,
        receivedByName: 'SSLCommerz',
      },
      user: by,
      idempotencyKey: receiptKey(fresh.tranId),
      ctx,
      checkDate: false,
      auditMeta: { tranId: fresh.tranId, source },
      async inTransaction(session, rec) {
        const res = await OnlinePayment.updateOne(
          { orgId, _id: fresh._id, status: { $in: allowed } },
          {
            $set: {
              status: 'paid',
              receiptId: rec._id,
              receiptNo: rec.receiptNo,
              paidAt: new Date(),
              reviewReason: fresh.reviewReason ?? null,
            },
            ...event(source, 'PAID', rec.receiptNo),
          },
          { session },
        );
        // Decided meanwhile (e.g. rejected by staff) → no receipt (the transaction aborts).
        if (!res.modifiedCount) {
          throw new ConflictError('The payment changed meanwhile', { code: 'PAYMENT_BUSY' });
        }
      },
    });
    receipt = r.receipt;
    if (r.replayed) {
      // Another trigger won the race — make sure the payment points at that receipt.
      await OnlinePayment.updateOne(
        { orgId, _id: fresh._id, status: { $ne: 'paid' } },
        {
          $set: {
            status: 'paid',
            receiptId: receipt._id,
            receiptNo: receipt.receiptNo,
            paidAt: new Date(),
          },
        },
      );
      return 'paid';
    }
  } catch (err) {
    if (fromReview) throw err; // the reviewer sees the reason (OVERPAYMENT …)
    const reason = ['OVERPAYMENT', 'BOOKING_NOT_ACTIVE'].includes(err.code)
      ? err.code
      : 'RECEIPT_FAILED';
    if (reason === 'RECEIPT_FAILED')
      log.error(
        { tranId: fresh.tranId, err: { message: err.message, code: err.code } },
        'online receipt failed',
      );
    return holdForReview(fresh, reason, source);
  }

  // After the commit: tell the seller and the client (the receipt e-mail with the PDF goes by itself).
  await notify(orgId, [booking.soldBy], 'online_payment.received', {
    paymentId: String(fresh._id),
    bookingId: String(booking._id),
    bookingNo: booking.bookingNo,
    customerName: fresh.customerName,
    amount: fresh.amount,
    receiptNo: receipt.receiptNo,
  });
  const customer = await Customer.findOne({ orgId, _id: fresh.customerId }).lean();
  if (customer) {
    const tk = formatTaka(fresh.amount, { decimals: fresh.amount % 100 !== 0 });
    await notifyClient({
      org,
      customer,
      bookingId: booking._id,
      sms: {
        bn: `${org.nameBn || org.name}: অনলাইনে ৳${tk} পেমেন্ট গ্রহণ করা হয়েছে। রসিদ নং ${receipt.receiptNo}। ধন্যবাদ।`,
        en: `${org.name}: online payment of Tk ${tk} received. Receipt no. ${receipt.receiptNo}. Thank you.`,
      },
    });
  }
  return 'paid';
}

// ── Reconcile job ───────────────────────────────────────────────────────────────

/**
 * Job `payments.reconcile` (every 10 min per org): attempts that never got a callback/IPN are
 * looked up by tran_id. VALID → settle; nothing after 3 h → expired.
 */
export async function reconcilePayments(orgId, { now = new Date(), limit = 50 } = {}) {
  if (!getIntegrationConfig(orgId, 'payment').enabled) return { checked: 0 };
  const rows = await OnlinePayment.find({
    orgId,
    status: { $in: ['initiated', 'failed', 'cancelled'] },
    createdAt: {
      $lt: new Date(now - RECONCILE_AFTER_MS),
      $gt: new Date(now - RECONCILE_WINDOW_MS),
    },
    $or: [
      { lastCheckedAt: null },
      { lastCheckedAt: { $lt: new Date(now - RECONCILE_RECHECK_MS) } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  const out = { checked: 0, paid: 0, review: 0, expired: 0, errors: 0 };
  for (const p of rows) {
    out.checked += 1;
    try {
      const status = await reconcileOne(p, now);
      if (status in out) out[status] += 1;
    } catch (err) {
      out.errors += 1;
      log.warn({ tranId: p.tranId, code: err.code, msg: err.message }, 'reconcile failed');
      await OnlinePayment.updateOne({ orgId, _id: p._id }, { $set: { lastCheckedAt: new Date() } });
    }
  }
  return out;
}

export async function reconcileOne(p, now = new Date()) {
  const orgId = p.orgId;
  const txns = await sslcz.queryByTranId(orgId, p.tranId);
  const valid = txns.find((t) => ['VALID', 'VALIDATED'].includes(t.status) && t.valId);
  if (valid) return settleWithValidation(p, valid.valId, 'reconcile');
  const summary = txns.map((t) => t.status).join(',') || 'NONE';
  const age = now - new Date(p.createdAt);
  const pending = txns.some((t) => t.status === 'PENDING');
  const set = { lastCheckedAt: new Date() };
  let status = p.status;
  if (p.status === 'initiated' && !pending && age > EXPIRE_AFTER_MS) {
    set.status = txns.length ? 'failed' : 'expired';
    status = set.status;
  }
  await OnlinePayment.updateOne(
    { orgId, _id: p._id, status: p.status },
    { $set: set, ...event('reconcile', summary) },
  );
  return status;
}

// ── Staff ───────────────────────────────────────────────────────────────────────

const canSeeAll = (user) =>
  user.permissions.has(P.ONLINE_PAYMENTS_REVIEW) || user.permissions.has(P.BOOKINGS_READ_ALL);
const staffScope = (user) => (canSeeAll(user) ? {} : { soldBy: oid(user.id) });

export async function listPayments(orgId, user, { status, bookingId, cursor, limit }) {
  const filter = { orgId, ...staffScope(user), ...cursorFilter(cursor) };
  if (status) filter.status = status;
  if (bookingId) filter.bookingId = oid(bookingId);
  const rows = await OnlinePayment.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toStaffOnlinePayment), meta };
}

async function getStaffDoc(orgId, user, id) {
  const p = await OnlinePayment.findOne({ orgId, _id: id, ...staffScope(user) }).lean();
  if (!p) throw new NotFoundError('Payment not found');
  return p;
}

export async function getPayment(orgId, user, id) {
  return toStaffOnlinePayment(await getStaffDoc(orgId, user, id));
}

/** Re-ask SSLCommerz now (stuck "initiated", or before deciding a review). */
export async function recheckPayment({ orgId, user, id, ctx }) {
  const p = await getStaffDoc(orgId, user, id);
  if (['paid', 'rejected'].includes(p.status)) return toStaffOnlinePayment(p);
  if (p.status === 'review') {
    // Refresh the gateway facts only; a held payment stays held until a person decides.
    const txns = await sslcz.queryByTranId(orgId, p.tranId);
    await OnlinePayment.updateOne(
      { orgId, _id: p._id },
      {
        $set: { lastCheckedAt: new Date() },
        ...event('staff', txns.map((t) => t.status).join(',') || 'NONE'),
      },
    );
  } else await reconcileOne(p);
  await audit(ctx, 'online_payment.recheck', { entity: { type: 'OnlinePayment', id: p._id } });
  return getPayment(orgId, user, id);
}

/** A held payment is genuine (risk checked, documents seen): write the receipt. */
export async function approveReview({ orgId, user, id, note, ctx }) {
  const p = await getStaffDoc(orgId, user, id);
  if (p.status !== 'review') {
    throw new ConflictError('Only a payment under review can be approved', {
      code: 'PAYMENT_NOT_IN_REVIEW',
    });
  }
  if (p.reviewReason === 'AMOUNT_MISMATCH') {
    throw new ConflictError(
      'The gateway amount differs — reject it and refund from the SSLCommerz panel',
      {
        code: 'AMOUNT_MISMATCH',
      },
    );
  }
  await postReceipt(p, {
    source: 'staff',
    tranDate: p.gateway?.tranDate,
    by: user,
    note,
    fromReview: true,
  });
  await OnlinePayment.updateOne(
    { orgId, _id: p._id },
    {
      $set: {
        review: {
          at: new Date(),
          by: oid(user.id),
          byName: user.name,
          decision: 'approved',
          note: note ?? null,
        },
      },
    },
  );
  await audit(ctx, 'online_payment.approve', {
    entity: { type: 'OnlinePayment', id: p._id },
    meta: { tranId: p.tranId, reason: p.reviewReason, note },
  });
  return getPayment(orgId, user, id);
}

/** Not accepted (fraud, booking cancelled …): no receipt; refund from the SSLCommerz panel. */
export async function rejectReview({ org, user, id, reason, ctx }) {
  const orgId = org._id;
  const p = await getStaffDoc(orgId, user, id);
  const res = await OnlinePayment.updateOne(
    { orgId, _id: p._id, status: 'review' },
    {
      $set: {
        status: 'rejected',
        review: {
          at: new Date(),
          by: oid(user.id),
          byName: user.name,
          decision: 'rejected',
          note: reason,
        },
      },
      ...event('staff', 'REJECTED', reason),
    },
  );
  if (!res.modifiedCount) {
    throw new ConflictError('Only a payment under review can be rejected', {
      code: 'PAYMENT_NOT_IN_REVIEW',
    });
  }
  await audit(ctx, 'online_payment.reject', {
    entity: { type: 'OnlinePayment', id: p._id },
    meta: { tranId: p.tranId, amount: p.amount, reason },
  });
  const customer = await Customer.findOne({ orgId, _id: p.customerId }).lean();
  if (customer) {
    const tk = formatTaka(p.amount, { decimals: p.amount % 100 !== 0 });
    await notifyClient({
      org,
      customer,
      bookingId: p.bookingId,
      sms: {
        bn: `${org.nameBn || org.name}: আপনার ৳${tk} অনলাইন পেমেন্ট (${p.tranId}) গ্রহণ করা যায়নি; টাকা ফেরত দেওয়া হবে। প্রশ্ন থাকলে অফিসে যোগাযোগ করুন।`,
        en: `${org.name}: your online payment of Tk ${tk} (${p.tranId}) could not be accepted and will be refunded. Please contact the office with questions.`,
      },
    });
  }
  return getPayment(orgId, user, id);
}

// ── Portal reads ────────────────────────────────────────────────────────────────

export async function listMyPayments(org, user, { cursor, limit }) {
  const c = await portalCustomer(org._id, user);
  const rows = await OnlinePayment.find({
    orgId: org._id,
    customerId: c._id,
    ...cursorFilter(cursor),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toOnlinePayment), meta };
}

/** The return page polls this until the status leaves `initiated`. */
export async function getMyPayment(org, user, id) {
  if (!mongoose.isValidObjectId(id)) throw new NotFoundError('Payment not found');
  const c = await portalCustomer(org._id, user);
  const p = await OnlinePayment.findOne({ orgId: org._id, _id: id, customerId: c._id }).lean();
  if (!p) throw new NotFoundError('Payment not found');
  return toOnlinePayment(p);
}
