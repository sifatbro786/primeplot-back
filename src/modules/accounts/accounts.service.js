import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import { BadRequestError, ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { fiscalYear, parseDhakaDate, toDhakaDate } from '#shared/utils/dhakaDate.js';
import { amountInWords, formatTaka } from '#shared/utils/money.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { audit } from '#modules/audit/audit.service.js';
import { queueSms } from '#modules/sms/sms.service.js';
import { AccountSettings } from './accountSettings.model.js';
import { BankAccount } from './bankAccount.model.js';
import { Cheque, OPEN_CHEQUE_STATUSES } from './cheque.model.js';
import { ensureCounter, nextSeq } from './counter.model.js';
import { LedgerEntry } from './ledgerEntry.model.js';
import { Receipt } from './receipt.model.js';

/**
 * Accounts (B4): settings, company bank accounts, receipt documents and the money ledger.
 * Schedules live on the booking (#modules/bookings); booking.service drives every money write
 * and calls into this module inside its transaction. Dependency is one-way: bookings → accounts.
 */
const log = logger.child({ module: 'accounts' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const idOrNull = (v) => (v ? String(v) : null);

const staleVersion = () =>
  new ConflictError('This record was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

// ── Settings ────────────────────────────────────────────────────────────────────

export async function getAccountSettings(orgId) {
  const found = await AccountSettings.findOne({ orgId }).lean();
  if (found) return found;
  try {
    return (await AccountSettings.create({ orgId })).toObject();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return AccountSettings.findOne({ orgId }).lean();
  }
}

export function toAccountSettings(s) {
  return {
    version: s.__v ?? 0,
    discountLimitBps: {
      sales_executive: s.discountLimitBps?.sales_executive ?? 100,
      sales_manager: s.discountLimitBps?.sales_manager ?? 300,
    },
    bookingMoneyRequired: s.bookingMoneyRequired ?? true,
    receiptBackdateDays: s.receiptBackdateDays ?? 31,
    chequeBounceFee: s.chequeBounceFee ?? 0,
    notify: {
      receiptEmail: s.notify?.receiptEmail ?? true,
      receiptSms: s.notify?.receiptSms ?? false,
    },
    portal: portalSettingsOf(s),
    reminders: reminderSettingsOf(s),
  };
}

/** B5.1 portal settings with defaults filled in (documents created before B5 lack them). */
export function portalSettingsOf(s) {
  const p = s?.portal ?? {};
  return {
    autoInvite: p.autoInvite ?? true,
    autoInviteCoApplicants: p.autoInviteCoApplicants ?? false,
    inviteSms: p.inviteSms ?? true,
    inviteEmail: p.inviteEmail ?? true,
    slipUpload: p.slipUpload ?? true,
    onlinePayment: p.onlinePayment ?? true,
    onlineMinAmount: p.onlineMinAmount ?? 100_000,
    resultSms: p.resultSms ?? true,
  };
}

export const DEFAULT_REMINDER_RULES = Object.freeze([
  { key: 'before_7', offsetDays: -7, enabled: true, sms: true, email: true },
  { key: 'due_day', offsetDays: 0, enabled: true, sms: true, email: true },
  { key: 'overdue_3', offsetDays: 3, enabled: true, sms: true, email: true },
  { key: 'overdue_15', offsetDays: 15, enabled: true, sms: true, email: true },
]);

/** B5.3 reminder settings with defaults filled in. Rules sorted by offset. */
export function reminderSettingsOf(s) {
  const r = s?.reminders ?? {};
  const rules = (r.rules?.length ? r.rules : DEFAULT_REMINDER_RULES).map((x) => ({
    key: x.key,
    offsetDays: x.offsetDays,
    enabled: x.enabled ?? true,
    sms: x.sms ?? true,
    email: x.email ?? true,
  }));
  rules.sort((a, b) => a.offsetDays - b.offsetDays);
  return { enabled: r.enabled ?? true, sendHour: r.sendHour ?? 10, rules };
}

const SETTINGS_PATHS = [
  'discountLimitBps',
  'bookingMoneyRequired',
  'receiptBackdateDays',
  'chequeBounceFee',
  'notify',
  'portal',
  'reminders',
];

export async function updateAccountSettings({ orgId, patch, ctx }) {
  await getAccountSettings(orgId);
  const doc = await AccountSettings.findOne({ orgId });
  if (doc.__v !== patch.version) throw staleVersion();
  const before = doc.toObject();
  const { version: _v, ...input } = patch;
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === 'object')
      for (const [kk, vv] of Object.entries(v)) doc.set(`${k}.${kk}`, vv);
    else doc.set(k, v);
  }
  await doc.save();
  const diff = diffFields(before, doc.toObject(), SETTINGS_PATHS);
  if (diff)
    await audit(ctx, 'accounts.settings_update', {
      entity: { type: 'AccountSettings', id: doc._id },
      diff,
    });
  return toAccountSettings(doc.toObject());
}

/**
 * Discount cap for this user, in basis points of the base price; null = no cap.
 * The cap is a per-role setting; `bookings:discount_unlimited` lifts it.
 */
export function discountCapBps(settings, user) {
  if (user.permissions.has(P.DISCOUNT_UNLIMITED)) return null;
  const v = settings.discountLimitBps?.[user.role];
  return Number.isInteger(v) ? v : 0;
}

// ── Bank accounts ───────────────────────────────────────────────────────────────

export function toBankAccount(b) {
  return {
    id: String(b._id),
    name: b.name,
    bankName: b.bankName,
    branch: b.branch ?? null,
    accountName: b.accountName ?? null,
    accountNo: b.accountNo,
    routingNo: b.routingNo ?? null,
    active: b.active,
    version: b.__v ?? 0,
  };
}

export async function listBankAccounts(orgId, { active } = {}) {
  const filter = { orgId };
  if (active !== undefined) filter.active = active;
  const rows = await BankAccount.find(filter).sort({ active: -1, name: 1 }).lean();
  return rows.map(toBankAccount);
}

export async function createBankAccount({ orgId, input, ctx }) {
  const doc = await BankAccount.create({ orgId, ...input, createdBy: ctx.actor.id ?? null });
  await audit(ctx, 'bank_account.create', {
    entity: { type: 'BankAccount', id: doc._id },
    meta: { name: doc.name, accountNo: doc.accountNo },
  });
  return toBankAccount(doc.toObject());
}

const BANK_FIELDS = [
  'name',
  'bankName',
  'branch',
  'accountName',
  'accountNo',
  'routingNo',
  'active',
];

export async function updateBankAccount({ orgId, id, patch, ctx }) {
  const doc = await BankAccount.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Bank account not found');
  if (doc.__v !== patch.version) throw staleVersion();
  const before = doc.toObject();
  const { version: _v, ...input } = patch;
  for (const [k, v] of Object.entries(input)) doc.set(k, v);
  await doc.save();
  const diff = diffFields(before, doc.toObject(), BANK_FIELDS);
  if (diff)
    await audit(ctx, 'bank_account.update', { entity: { type: 'BankAccount', id: doc._id }, diff });
  return toBankAccount(doc.toObject());
}

/** An active company account, or 422. */
export async function assertActiveBankAccount(orgId, id, { session } = {}) {
  const b = await BankAccount.findOne({ orgId, _id: id, active: true })
    .session(session ?? null)
    .lean();
  if (!b) {
    throw new BadRequestError('Pick an active company bank account', {
      code: 'INVALID_BANK_ACCOUNT',
      details: [{ path: 'payment.bankAccountId', message: 'Not found or inactive' }],
    });
  }
  return b;
}

// ── Receipts ────────────────────────────────────────────────────────────────────

const receiptKey = (projectId, fyStartYear) => `receipt:${projectId}:${fyStartYear}`;

export function receiptNumber(projectCode, fy, seq) {
  return `${projectCode}-${fy.short}-${String(seq).padStart(6, '0')}`;
}

/** Before the transaction: make sure the receipt counter for that date's fiscal year exists. */
export async function prepareReceiptCounter(org, projectId, date) {
  const fy = fiscalYear(date, org.settings?.fiscalYearStartMonth ?? 7);
  await ensureCounter(org._id, receiptKey(projectId, fy.startYear));
}

/**
 * Write a receipt + its ledger entry INSIDE the caller's transaction. The caller (booking
 * service) has already computed `allocations` and updates the schedule cache itself.
 * `date` is 'YYYY-MM-DD' (Dhaka).
 */
export async function createReceiptDocs({
  org,
  session,
  booking,
  project,
  customerName,
  payment,
  allocations,
  context,
  user,
  idempotencyKey,
}) {
  const orgId = org._id;
  const fy = fiscalYear(payment.date, org.settings?.fiscalYearStartMonth ?? 7);
  const seq = await nextSeq(orgId, receiptKey(project._id, fy.startYear), { session });
  const receiptId = new ObjectId();
  const date = parseDhakaDate(payment.date);
  const amount = allocations.reduce((s, a) => s + a.amount, 0);

  const [receipt] = await Receipt.create(
    [
      {
        _id: receiptId,
        orgId,
        receiptNo: receiptNumber(project.code, fy, seq),
        seq,
        fyStartYear: fy.startYear,
        projectId: project._id,
        bookingId: booking._id,
        bookingNo: booking.bookingNo,
        unitId: booking.unitId,
        unitCode: booking.unitCode,
        customerId: booking.customerId,
        customerName,
        soldBy: booking.soldBy ?? null,
        date,
        amount,
        mode: payment.mode,
        bankAccountId: payment.bankAccountId ? oid(payment.bankAccountId) : null,
        reference: payment.reference ?? null,
        instrumentNo: payment.instrumentNo ?? null,
        instrumentBank: payment.instrumentBank ?? null,
        instrumentDate: payment.instrumentDate ? parseDhakaDate(payment.instrumentDate) : null,
        context,
        allocations,
        note: payment.note ?? null,
        receivedBy: user ? oid(user.id) : null,
        // B5: system receipts (SSLCommerz) have no user — the payment names the channel.
        receivedByName: user?.name ?? payment.receivedByName ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    ],
    { session },
  );
  await LedgerEntry.create(
    [
      {
        orgId,
        bookingId: booking._id,
        projectId: project._id,
        receiptId,
        ref: receipt.receiptNo,
        type: 'receipt',
        date,
        amount,
        allocations: allocations.map((a) => ({ itemId: a.itemId, amount: a.amount })),
        by: user ? oid(user.id) : null,
        byName: user?.name ?? payment.receivedByName ?? null,
      },
    ],
    { session },
  );
  return receipt.toObject();
}

/** A receipt by idempotency key (for safe client retries), or null. */
export function findReceiptByIdempotencyKey(orgId, key) {
  return Receipt.findOne({ orgId, idempotencyKey: key }).lean();
}

/** Lean receipt or 404 (visibility is checked by the caller). */
export async function getReceiptDoc(orgId, id, { session } = {}) {
  const r = await Receipt.findOne({ orgId, _id: id })
    .session(session ?? null)
    .lean();
  if (!r) throw new NotFoundError('Receipt not found');
  return r;
}

/**
 * Reverse a receipt INSIDE the caller's transaction: a negative ledger entry with the same
 * allocations, and the reversal stamp on the receipt. The number stays used (gapless).
 */
export async function reverseReceiptDocs({ orgId, session, receipt, reason, user, date }) {
  const entryId = new ObjectId();
  await LedgerEntry.create(
    [
      {
        _id: entryId,
        orgId,
        bookingId: receipt.bookingId,
        projectId: receipt.projectId,
        receiptId: receipt._id,
        ref: receipt.receiptNo,
        type: 'reversal',
        date: parseDhakaDate(date),
        amount: -receipt.amount,
        allocations: receipt.allocations.map((a) => ({ itemId: a.itemId, amount: -a.amount })),
        note: reason,
        by: user ? oid(user.id) : null,
        byName: user?.name ?? null,
      },
    ],
    { session },
  );
  const updated = await Receipt.findOneAndUpdate(
    { orgId, _id: receipt._id, status: 'valid' },
    {
      $set: {
        status: 'reversed',
        reversal: {
          at: new Date(),
          by: user ? oid(user.id) : null,
          byName: user?.name ?? null,
          reason,
          entryId,
        },
      },
    },
    { returnDocument: 'after', lean: true, session },
  );
  if (!updated) {
    throw new ConflictError('This receipt is already reversed', { code: 'ALREADY_REVERSED' });
  }
  return updated;
}

export function toReceipt(r, { bankAccounts } = {}) {
  const bank = r.bankAccountId ? bankAccounts?.get(String(r.bankAccountId)) : null;
  return {
    id: String(r._id),
    receiptNo: r.receiptNo,
    fiscalYear: r.fyStartYear,
    projectId: String(r.projectId),
    bookingId: String(r.bookingId),
    bookingNo: r.bookingNo,
    unitId: String(r.unitId),
    unitCode: r.unitCode,
    customerId: String(r.customerId),
    customerName: r.customerName,
    date: toDhakaDate(r.date),
    amount: r.amount,
    amountText: formatTaka(r.amount),
    amountInWords: { en: amountInWords(r.amount, 'en'), bn: amountInWords(r.amount, 'bn') },
    mode: r.mode,
    bankAccount: bank
      ? { id: bank.id, name: bank.name, bankName: bank.bankName, accountNo: bank.accountNo }
      : r.bankAccountId
        ? { id: String(r.bankAccountId) }
        : null,
    reference: r.reference ?? null,
    instrumentNo: r.instrumentNo ?? null,
    instrumentBank: r.instrumentBank ?? null,
    instrumentDate: r.instrumentDate ? toDhakaDate(r.instrumentDate) : null,
    context: r.context,
    allocations: r.allocations.map((a) => ({
      itemId: String(a.itemId),
      seq: a.seq,
      code: a.code,
      label: a.label ?? null,
      amount: a.amount,
    })),
    note: r.note ?? null,
    receivedBy: r.receivedBy
      ? { id: String(r.receivedBy), name: r.receivedByName ?? null }
      : r.receivedByName
        ? { id: null, name: r.receivedByName } // B5: online (SSLCommerz)
        : null,
    status: r.status,
    reversal: r.reversal
      ? {
          at: r.reversal.at,
          by: r.reversal.by ? { id: String(r.reversal.by), name: r.reversal.byName ?? null } : null,
          reason: r.reversal.reason,
        }
      : null,
    createdAt: r.createdAt,
  };
}

async function bankMap(orgId, receipts) {
  const ids = [...new Set(receipts.map((r) => idOrNull(r.bankAccountId)).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await BankAccount.find({ orgId, _id: { $in: ids } })
    .setOptions({ withDeleted: true })
    .lean();
  return new Map(rows.map((b) => [String(b._id), toBankAccount(b)]));
}

export async function serializeReceipts(orgId, receipts) {
  const bankAccounts = await bankMap(orgId, receipts);
  return receipts.map((r) => toReceipt(r, { bankAccounts }));
}

/**
 * Cursor list, newest first. `scope` narrows to the user's own bookings (soldBy) when they lack
 * bookings:read_all.
 */
export async function listReceipts(orgId, scope, q) {
  const filter = { orgId, ...scope, ...cursorFilter(q.cursor) };
  if (q.projectId) filter.projectId = oid(q.projectId);
  if (q.bookingId) filter.bookingId = oid(q.bookingId);
  if (q.mode) filter.mode = q.mode;
  if (q.status) filter.status = q.status;
  if (q.receiptNo) filter.receiptNo = q.receiptNo.toUpperCase();
  if (q.from || q.to) {
    filter.$and = [
      {
        date: {
          ...(q.from && { $gte: parseDhakaDate(q.from) }),
          ...(q.to && { $lte: parseDhakaDate(q.to) }),
        },
      },
    ];
  }
  const rows = await Receipt.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, q.limit);
  return { items: await serializeReceipts(orgId, items), meta };
}

export function receiptsOfBooking(orgId, bookingId) {
  return Receipt.find({ orgId, bookingId }).sort({ date: 1, seq: 1 }).lean();
}

export function ledgerOfBooking(orgId, bookingId, { session } = {}) {
  return LedgerEntry.find({ orgId, bookingId })
    .sort({ date: 1, createdAt: 1, _id: 1 })
    .session(session ?? null)
    .lean();
}

// ── Customer notification (after commit, best-effort) ───────────────────────────

const SMS_TEXT = {
  bn: ({ name, amount, receiptNo, company }) =>
    `প্রিয় ${name}, আপনার ৳${amount} পেমেন্ট গ্রহণ করা হয়েছে। রসিদ নং ${receiptNo}। ধন্যবাদ — ${company}`,
  en: ({ name, amount, receiptNo, company }) =>
    `Dear ${name}, we have received your payment of Tk ${amount}. Receipt no. ${receiptNo}. Thank you — ${company}`,
};

/**
 * Receipt SMS (setting `notify.receiptSms`, off by default — owner decision Q8). The e-mail with
 * the PDF arrives in B4.3. Never throws: a failed notification must not undo a receipt.
 */
export async function notifyReceipt({ org, receipt, customer }) {
  try {
    const settings = await getAccountSettings(org._id);
    if (!settings.notify?.receiptSms || !customer?.phone) return;
    const locale = customer.locale ?? org.settings?.defaultLocale ?? 'bn';
    const text = SMS_TEXT[locale === 'en' ? 'en' : 'bn']({
      name: customer.name.split(' ')[0],
      amount: formatTaka(receipt.amount, { decimals: receipt.amount % 100 !== 0 }),
      receiptNo: receipt.receiptNo,
      company: (locale === 'bn' && org.nameBn) || org.name,
    });
    await queueSms({ orgId: org._id, to: customer.phone, text, purpose: 'receipt', locale });
  } catch (err) {
    log.warn(
      { err: { message: err.message }, receiptId: String(receipt._id) },
      'receipt SMS failed',
    );
  }
}

// ── Cheques (B4.2) ──────────────────────────────────────────────────────────────

export function toCheque(c, { bankAccounts } = {}) {
  const bank = c.depositBankAccountId ? bankAccounts?.get(String(c.depositBankAccountId)) : null;
  return {
    id: String(c._id),
    bookingId: String(c.bookingId),
    bookingNo: c.bookingNo,
    projectId: String(c.projectId),
    unitCode: c.unitCode,
    customerId: String(c.customerId),
    customerName: c.customerName,
    chequeNo: c.chequeNo,
    bank: c.bank,
    branch: c.branch ?? null,
    chequeDate: toDhakaDate(c.chequeDate),
    amount: c.amount,
    receivedDate: toDhakaDate(c.receivedDate),
    postDated: c.chequeDate > c.receivedDate,
    status: c.status,
    depositBankAccount: bank
      ? { id: bank.id, name: bank.name, bankName: bank.bankName, accountNo: bank.accountNo }
      : c.depositBankAccountId
        ? { id: String(c.depositBankAccountId) }
        : null,
    depositedDate: c.depositedDate ? toDhakaDate(c.depositedDate) : null,
    clearedDate: c.clearedDate ? toDhakaDate(c.clearedDate) : null,
    receiptId: idOrNull(c.receiptId),
    bouncedDate: c.bouncedDate ? toDhakaDate(c.bouncedDate) : null,
    bounceReason: c.bounceReason ?? null,
    bounceCount: c.bounceCount ?? 0,
    returnedReason: c.returnedReason ?? null,
    history: (c.history ?? []).map((h) => ({
      status: h.status,
      date: toDhakaDate(h.date),
      at: h.at,
      by: h.by ? { id: String(h.by), name: h.byName ?? null } : null,
      note: h.note ?? null,
    })),
    note: c.note ?? null,
    createdAt: c.createdAt,
  };
}

async function chequeBankMap(orgId, cheques) {
  return bankMap(
    orgId,
    cheques.map((c) => ({ bankAccountId: c.depositBankAccountId })),
  );
}

export async function serializeCheques(orgId, cheques) {
  const bankAccounts = await chequeBankMap(orgId, cheques);
  return cheques.map((c) => toCheque(c, { bankAccounts }));
}

const historyEntry = (status, date, user, note) => ({
  status,
  date: parseDhakaDate(date),
  at: new Date(),
  by: user ? oid(user.id) : null,
  byName: user?.name ?? null,
  note: note ?? null,
});

/** Record a cheque in hand (status received). Pass `session` inside a transaction. */
export async function createChequeDoc({ orgId, booking, customerName, input, user, session }) {
  const receivedDate = input.receivedDate ?? toDhakaDate(booking.bookingDate);
  try {
    const [doc] = await Cheque.create(
      [
        {
          orgId,
          bookingId: booking._id,
          bookingNo: booking.bookingNo,
          projectId: booking.projectId,
          unitCode: booking.unitCode,
          customerId: booking.customerId,
          customerName,
          soldBy: booking.soldBy ?? null,
          chequeNo: input.chequeNo,
          bank: input.bank,
          branch: input.branch ?? null,
          chequeDate: parseDhakaDate(input.chequeDate),
          amount: input.amount,
          receivedDate: parseDhakaDate(receivedDate),
          history: [historyEntry('received', receivedDate, user, input.note)],
          note: input.note ?? null,
          createdBy: user ? oid(user.id) : null,
        },
      ],
      { session },
    );
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.chequeNo) {
      throw new ConflictError('This cheque is already in the register', {
        code: 'DUPLICATE_CHEQUE',
        details: [{ path: 'chequeNo', message: 'Already received' }],
      });
    }
    throw err;
  }
}

export async function getChequeDoc(orgId, id, { session } = {}) {
  const c = await Cheque.findOne({ orgId, _id: id })
    .session(session ?? null)
    .lean();
  if (!c) throw new NotFoundError('Cheque not found');
  return c;
}

/** Sum of cheques still in play for a booking (received + deposited). */
export async function openChequesOf(orgId, bookingId, { session } = {}) {
  return Cheque.find({ orgId, bookingId, status: { $in: OPEN_CHEQUE_STATUSES } })
    .session(session ?? null)
    .lean();
}

/**
 * Atomic status change: only from `from`, else 409 CHEQUE_STATE_CONFLICT { status }.
 * `set` holds the extra fields; a history line is appended.
 */
export async function chequeTransition({
  orgId,
  id,
  from,
  to,
  date,
  user,
  note,
  set = {},
  inc,
  session,
}) {
  const c = await Cheque.findOneAndUpdate(
    { orgId, _id: id, status: { $in: from } },
    {
      $set: { status: to, ...set },
      $push: { history: historyEntry(to, date, user, note) },
      ...(inc && { $inc: inc }),
    },
    { returnDocument: 'after', lean: true, ...(session && { session }) },
  );
  if (!c) {
    const cur = await getChequeDoc(orgId, id, { session });
    throw new ConflictError(`A ${cur.status} cheque cannot become ${to}`, {
      code: 'CHEQUE_STATE_CONFLICT',
      details: { status: cur.status },
    });
  }
  return c;
}

export async function listCheques(orgId, scope, q) {
  const filter = { orgId, ...scope, ...cursorFilter(q.cursor) };
  if (q.status) filter.status = q.status;
  else if (q.open === 'true') filter.status = { $in: OPEN_CHEQUE_STATUSES };
  if (q.projectId) filter.projectId = oid(q.projectId);
  if (q.bookingId) filter.bookingId = oid(q.bookingId);
  if (q.q) filter.chequeNo = { $regex: `^${q.q.replace(/[^0-9A-Za-z-]/g, '')}` };
  if (q.dueFrom || q.dueTo) {
    filter.chequeDate = {
      ...(q.dueFrom && { $gte: parseDhakaDate(q.dueFrom) }),
      ...(q.dueTo && { $lte: parseDhakaDate(q.dueTo) }),
    };
  }
  const rows = await Cheque.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, q.limit);
  return { items: await serializeCheques(orgId, items), meta };
}

/** PDC / open cheque report rows (B4.2 reports). */
export function chequesForReport(orgId, { projectId, from, to }) {
  const filter = {
    orgId,
    status: { $in: [...OPEN_CHEQUE_STATUSES, 'bounced'] },
    chequeDate: { $gte: parseDhakaDate(from), $lte: parseDhakaDate(to) },
  };
  if (projectId) filter.projectId = oid(projectId);
  return Cheque.find(filter).sort({ chequeDate: 1, _id: 1 }).lean();
}

// ── Refunds (B4.2) ──────────────────────────────────────────────────────────────

export const refundKey = (projectId) => `refund:${projectId}`;

/** A refund paid out after a cancellation — negative, unallocated ledger entry. */
export async function createRefundEntry({ orgId, session, booking, project, input, date, user }) {
  const seq = await nextSeq(orgId, refundKey(project._id), { session });
  const ref = `${project.code}-RF-${String(seq).padStart(5, '0')}`;
  const [entry] = await LedgerEntry.create(
    [
      {
        orgId,
        bookingId: booking._id,
        projectId: booking.projectId,
        ref,
        type: 'refund',
        date: parseDhakaDate(date),
        amount: -input.amount,
        allocations: [],
        note: [
          `mode:${input.mode}`,
          input.instrumentNo && `no:${input.instrumentNo}`,
          input.reference && `ref:${input.reference}`,
          input.bankAccountId && `account:${input.bankAccountId}`,
          input.note,
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 500),
        by: user ? oid(user.id) : null,
        byName: user?.name ?? null,
      },
    ],
    { session },
  );
  return entry.toObject();
}

// ── Reports (B4.2) ──────────────────────────────────────────────────────────────

/** Valid receipts in a date range, grouped (Dhaka calendar). */
export async function collectionSummary(orgId, { projectId, from, to, interval }) {
  const match = {
    orgId: oid(orgId),
    status: 'valid',
    date: { $gte: parseDhakaDate(from), $lte: parseDhakaDate(to) },
  };
  if (projectId) match.projectId = oid(projectId);
  const fmt = interval === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const [facet] = await Receipt.aggregate([
    { $match: match },
    {
      $facet: {
        total: [{ $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } }],
        byMode: [
          { $group: { _id: '$mode', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ],
        byProject: [
          { $group: { _id: '$projectId', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ],
        byPeriod: [
          {
            $group: {
              _id: { $dateToString: { format: fmt, date: '$date', timezone: 'Asia/Dhaka' } },
              count: { $sum: 1 },
              amount: { $sum: '$amount' },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);
  const refundMatch = {
    orgId: oid(orgId),
    type: 'refund',
    date: match.date,
    ...(projectId && { projectId: oid(projectId) }),
  };
  const [refunds] = await LedgerEntry.aggregate([
    { $match: refundMatch },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);
  const reversed = await Receipt.countDocuments({
    orgId,
    status: 'reversed',
    date: match.date,
    ...(projectId && { projectId: oid(projectId) }),
  });
  const row = (g) => ({ count: g.count, amount: g.amount });
  return {
    total: facet.total[0] ? row(facet.total[0]) : { count: 0, amount: 0 },
    byMode: facet.byMode.map((g) => ({ mode: g._id, ...row(g) })),
    byProject: facet.byProject.map((g) => ({ projectId: String(g._id), ...row(g) })),
    byPeriod: facet.byPeriod.map((g) => ({ period: g._id, ...row(g) })),
    refunds: refunds ? { count: refunds.count, amount: -refunds.amount } : { count: 0, amount: 0 },
    reversedReceipts: reversed,
  };
}

export function chequesOfBooking(orgId, bookingId) {
  return Cheque.find({ orgId, bookingId }).sort({ receivedDate: 1, createdAt: 1 }).lean();
}
