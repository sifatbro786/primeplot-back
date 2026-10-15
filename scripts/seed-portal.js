// Demo CUSTOMER-PORTAL data for development (B5): client logins, bank slips, online payments,
// profile change requests and the installment-reminder log — every state the staff review
// queues (Payment slips · Online payments · Profile requests · Reminders) and the portal show.
//
//   npm run seed:portal          # create (skipped when demo slips already exist)
//
// Needs `npm run seed`, `seed:demo` and `seed:sales` first (it works on the demo buyers'
// active bookings). Slips, profile requests, approvals and reminder runs go through the real
// services; gateway-side online payments (SSLCommerz never runs here) are written directly and
// "paid" ones are settled through the staff-approval path so a real receipt exists.
//
// Nothing leaves the machine: invite links are off while seeding, and every SMS / e-mail job
// the run queues is removed afterwards (the SMS rows stay in the delivery log as sent).
// Receipts are permanent (append-only ledger) — the only clean slate is a fresh database.
// Never run it on production.
//
// Portal sign-in for every demo client:  phone (e.g. 01888000001) + password below.
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { env } from '#config/env.js';
import { connectDB, disconnectDB } from '#config/db.js';
import '#jobs/index.js'; // registers job types — SMS / e-mail / receipt jobs are queued (then removed)
import { permissionsFor } from '#shared/auth/permissions.js';
import { hashPassword } from '#shared/crypto/password.js';
import { addDays, parseDhakaDate, toDhakaDate, todayDhaka } from '#shared/utils/dhakaDate.js';
import { Job } from '#jobs/job.model.js';
import { smsInfo } from '#integrations/sms/index.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { User } from '#modules/users/user.model.js';
import { Customer } from '#modules/customers/customer.model.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { BankAccount } from '#modules/accounts/bankAccount.model.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { scheduleTotals } from '#modules/accounts/allocation.js';
import { createMedia } from '#modules/media/media.service.js';
import { invitePortalUser } from '#modules/portal/portalAccount.service.js';
import * as portal from '#modules/portal/portal.service.js';
import * as review from '#modules/portal/review.service.js';
import { PaymentSlip } from '#modules/portal/paymentSlip.model.js';
import { ProfileRequest } from '#modules/portal/profileRequest.model.js';
import {
  zProfileRequest,
  zReason,
  zSlipApprove,
  zSlipCreate,
} from '#modules/portal/portal.validation.js';
import { OnlinePayment } from '#modules/payments/onlinePayment.model.js';
import { approveReview, newTranId, rejectReview } from '#modules/payments/payment.service.js';
import { remindNow, runReminders } from '#modules/reminders/reminder.service.js';
import { ReminderLog } from '#modules/reminders/reminderLog.model.js';
import { SmsMessage } from '#modules/sms/smsMessage.model.js';

parseArgs({ options: {} });

if (env.isProd) {
  console.error('\n✖ seed:portal refuses to run with NODE_ENV=production\n');
  process.exit(1);
}

const PASSWORD = 'Portal@2026';
const TK = 100;
const DEMO_PHONE = /^\+(8801888|447700900)/;
const TODAY = todayDhaka();
const ago = (days) => addDays(TODAY, -days);
const maxDate = (a, b) => (a > b ? a : b);
const roundTk = (poisha, step = 1_000) =>
  Math.max(step, Math.floor(poisha / (step * TK)) * step) * TK;
/** A Dhaka wall-clock moment on `ymd` (default 10:30, after the reminder send hour). */
const at = (ymd, hh = 10, mm = 30) =>
  new Date(parseDhakaDate(ymd).getTime() + (hh * 60 + mm) * 60_000);
const { ObjectId } = mongoose.Types;

/** createdAt/updatedAt are set by Mongoose on insert — move them to when it "happened". */
const backdate = (Model, id, when, extra = {}) =>
  Model.collection.updateOne(
    { _id: new ObjectId(String(id)) },
    { $set: { createdAt: when, updatedAt: when, ...extra } },
  );

/** A believable bank deposit slip, rendered to PNG (stored as a private payment_slip). */
function slipPng({ bank, branch, account, payer, amountTk, date, ref, channel }) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const row = (y, label, value) =>
    `<text x="48" y="${y}" font-size="17" fill="#666861">${esc(label)}</text>
     <text x="300" y="${y}" font-size="19" fill="#1C1D1A" font-weight="600">${esc(value)}</text>
     <line x1="300" y1="${y + 8}" x2="852" y2="${y + 8}" stroke="#C9C6BF" stroke-dasharray="4 4"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" font-family="Arial, Helvetica, sans-serif">
  <rect width="900" height="560" fill="#FBFAF6"/>
  <rect x="16" y="16" width="868" height="528" fill="none" stroke="#2D3228" stroke-width="2"/>
  <rect x="16" y="16" width="868" height="76" fill="#2D3228"/>
  <text x="48" y="62" font-size="28" fill="#F9F8F6" font-weight="700">${esc(bank)}</text>
  <text x="852" y="52" font-size="15" fill="#D8D6CF" text-anchor="end">${esc(branch)} Branch</text>
  <text x="852" y="74" font-size="15" fill="#D8D6CF" text-anchor="end">${esc(
    channel === 'pay_order'
      ? 'PAY ORDER COUNTERFOIL'
      : channel === 'cash_deposit'
        ? 'CASH DEPOSIT SLIP'
        : 'FUND TRANSFER ADVICE',
  )}</text>
  ${row(150, 'Date', date)}
  ${row(200, 'Credit account', account)}
  ${row(250, 'Depositor / remitter', payer)}
  ${row(300, 'Reference / Txn ID', ref)}
  ${row(350, 'Amount (BDT)', `${Number(amountTk).toLocaleString('en-IN')}.00`)}
  <rect x="600" y="400" width="240" height="110" fill="none" stroke="#6B705C" stroke-width="3" rx="6" transform="rotate(-6 720 455)"/>
  <text x="720" y="450" font-size="22" fill="#6B705C" font-weight="700" text-anchor="middle" transform="rotate(-6 720 455)">RECEIVED</text>
  <text x="720" y="480" font-size="15" fill="#6B705C" text-anchor="middle" transform="rotate(-6 720 455)">${esc(date)}</text>
  <text x="48" y="520" font-size="13" fill="#9A988F">Demo document generated by PrimePlot seed:portal — not a real bank record.</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

await connectDB({ retries: 2 });
let restore = null;
try {
  const org = await getCurrentOrg();
  const orgId = org._id;
  if (smsInfo(orgId).live) {
    // A running API would deliver this run's queued SMS before they are cleaned up — and the
    // demo numbers (+8801888…) are real-format Bangladeshi numbers.
    throw new Error(
      'SMS is live (SMS_DRIVER is not "log") — set SMS_DRIVER=log in .env, then seed.',
    );
  }
  const seedStartId = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 1);

  const demoCustomers = await Customer.find({
    orgId,
    phone: DEMO_PHONE,
  }).lean();
  if (!demoCustomers.length) {
    throw new Error('No demo customers — run `npm run seed:sales` first.');
  }
  const demoIds = demoCustomers.map((c) => c._id);
  if (await PaymentSlip.exists({ orgId, customerId: { $in: demoIds } })) {
    console.log(
      '• Demo portal data already exists — nothing created. Use a fresh database for a clean demo.',
    );
    throw Object.assign(new Error('skip'), { skip: true });
  }

  // ── People ──
  const asUser = (u) => ({
    id: String(u._id),
    orgId,
    role: u.role,
    name: u.name,
    email: u.email,
    permissions: permissionsFor(u.role),
  });
  const adminDoc = await User.findOne({
    orgId,
    role: 'admin',
    status: 'active',
  })
    .sort({ createdAt: 1 })
    .lean();
  if (!adminDoc) throw new Error('No active admin — run `npm run seed` first.');
  const admin = asUser(adminDoc);
  const ctxOf = (user) => ({
    orgId,
    actor: { id: user.id, role: user.role, name: user.name, kind: 'user' },
    ip: null,
    userAgent: 'seed-portal',
    requestId: null,
  });
  const ctx = ctxOf(admin);

  // ── Settings: portal features on, nothing sent outside while seeding ──
  const before = accounts.toAccountSettings(await accounts.getAccountSettings(orgId));
  const tmp = await accounts.updateAccountSettings({
    orgId,
    patch: {
      version: before.version,
      notify: { receiptEmail: false },
      portal: {
        autoInvite: false,
        inviteSms: false,
        inviteEmail: false,
        slipUpload: true,
        onlinePayment: true,
        resultSms: true,
      },
      reminders: { enabled: true },
    },
    ctx,
  });
  restore = async () =>
    accounts.updateAccountSettings({
      orgId,
      patch: {
        version: tmp.version,
        notify: { receiptEmail: before.notify.receiptEmail },
        portal: before.portal,
        reminders: { enabled: before.reminders.enabled },
      },
      ctx,
    });

  // ── Who gets a portal login: holders of active bookings with money still to pay ──
  const today = TODAY;
  const bookings = (
    await Booking.find({
      orgId,
      status: 'active',
      customerId: { $in: demoIds },
    })
      .sort({ bookingDate: 1 })
      .lean()
  )
    .map((b) => ({ b, totals: scheduleTotals(b.schedule, today) }))
    .filter((x) => x.totals.outstanding >= 50_000 * TK);
  const byCustomer = new Map();
  for (const x of bookings) {
    const k = String(x.b.customerId);
    if (!byCustomer.has(k)) byCustomer.set(k, x);
  }
  const picks = [...byCustomer.values()].slice(0, 7);
  if (picks.length < 5) throw new Error('Need at least 5 demo buyers with dues — run seed:sales.');
  const custOf = new Map(demoCustomers.map((c) => [String(c._id), c]));

  const passwordHash = await hashPassword(PASSWORD);
  const clients = [];
  for (const [i, x] of picks.entries()) {
    const c = custOf.get(String(x.b.customerId));
    const inv = await invitePortalUser({
      org,
      customerId: c._id,
      by: admin,
      ctx,
    });
    // The last one stays "invited" (setup link never used) so that state shows too.
    if (i < picks.length - 1) {
      await User.updateOne(
        { orgId, _id: inv.userId },
        {
          $set: {
            status: 'active',
            passwordHash,
            passwordChangedAt: new Date(),
            lastLoginAt: at(ago(i + 1), 20, 15),
          },
        },
      );
    }
    const u = await User.findOne({ orgId, _id: inv.userId }).lean();
    clients.push({
      user: asUser(u),
      customer: c,
      booking: x.b,
      active: i < picks.length - 1,
    });
  }
  const live = clients.filter((x) => x.active);
  console.log(
    `✔ Portal logins: ${clients.length} (${live.length} active, 1 invited) — password ${PASSWORD}`,
  );

  // ── Bank slips ──
  const banks = await BankAccount.find({ orgId, active: true }).sort({ createdAt: 1 }).lean();
  if (!banks.length) throw new Error('No active bank account — run `npm run seed:sales` first.');
  const PAYER_BANKS = [
    'Eastern Bank PLC',
    'City Bank PLC',
    'Islami Bank Bangladesh PLC',
    'Sonali Bank PLC',
  ];
  let refSeq = 0;

  async function slip(client, { daysAgo, channel, share, note }) {
    const { user, customer, booking } = client;
    const fresh = await Booking.findOne({ orgId, _id: booking._id }).lean();
    const outstanding = scheduleTotals(fresh.schedule, today).outstanding;
    const pending = await portal.pendingSlipTotal(orgId, booking._id);
    const amount = roundTk(Math.min((outstanding - pending) * share, 4 * 100_000 * TK));
    const paidOn = maxDate(ago(daysAgo), toDhakaDate(fresh.bookingDate));
    const bank = channel === 'pay_order' ? null : banks[refSeq % banks.length];
    refSeq += 1;
    const reference =
      channel === 'bank_transfer'
        ? `NPSB${String(26_100_000 + refSeq * 7_331)}`
        : channel === 'cash_deposit'
          ? `CD-${String(880_000 + refSeq)}`
          : `PO-${String(512_000 + refSeq)}`;
    const payerBank = PAYER_BANKS[refSeq % PAYER_BANKS.length];
    const png = await slipPng({
      bank: channel === 'pay_order' ? payerBank : bank.bankName,
      branch: channel === 'pay_order' ? 'Motijheel' : bank.branch,
      account: bank ? `${bank.accountName} · ${bank.accountNo}` : `${org.name} (payee)`,
      payer: customer.name,
      amountTk: amount / TK,
      date: paidOn,
      ref: reference,
      channel,
    });
    const media = await createMedia({
      orgId,
      user,
      file: {
        buffer: png,
        originalname: `slip-${reference}.png`,
        mimetype: 'image/png',
      },
      visibility: 'private',
      purpose: 'payment_slip',
      ctx: ctxOf(user),
    });
    const s = await portal.submitSlip({
      org,
      user,
      bookingId: String(booking._id),
      input: zSlipCreate.parse({
        amount,
        paidOn,
        channel,
        bankAccountId: bank ? String(bank._id) : null,
        reference,
        payerBank: channel === 'bank_transfer' ? payerBank : null,
        mediaId: String(media._id),
        note: note ?? null,
      }),
      ctx: ctxOf(user),
    });
    await backdate(PaymentSlip, s.id, at(paidOn, 18, 40));
    return s;
  }

  const [A, B, C, D, E = live[0]] = live;
  const counts = { approved: 0, rejected: 0, withdrawn: 0, pending: 0 };

  // Decided first (approval writes a receipt and lowers what is owed).
  for (const [client, days, channel] of [
    [A, 24, 'bank_transfer'],
    [D, 12, 'cash_deposit'],
  ]) {
    const s = await slip(client, { daysAgo: days, channel, share: 0.08 });
    await review.approveSlip({
      org,
      user: admin,
      id: s.id,
      input: zSlipApprove.parse({}),
      ctx,
    });
    await PaymentSlip.collection.updateOne(
      { _id: new ObjectId(s.id) },
      { $set: { 'review.at': at(ago(days - 1), 12, 5) } },
    );
    counts.approved += 1;
  }
  {
    const s = await slip(B, {
      daysAgo: 9,
      channel: 'bank_transfer',
      share: 0.06,
    });
    await review.rejectSlip({
      org,
      user: admin,
      id: s.id,
      ...zReason.parse({
        reason: 'Amount does not match our bank statement — please upload the bank advice again.',
      }),
      ctx,
    });
    counts.rejected += 1;
  }
  {
    const s = await slip(C, {
      daysAgo: 6,
      channel: 'bank_transfer',
      share: 0.05,
      note: 'Uploaded the wrong month by mistake',
    });
    await portal.withdrawSlip({
      org,
      user: C.user,
      id: s.id,
      ctx: ctxOf(C.user),
    });
    counts.withdrawn += 1;
  }
  // Waiting in the staff queue.
  await slip(A, {
    daysAgo: 2,
    channel: 'bank_transfer',
    share: 0.05,
    note: 'October installment',
  });
  await slip(B, { daysAgo: 1, channel: 'cash_deposit', share: 0.04 });
  await slip(C, {
    daysAgo: 0,
    channel: 'pay_order',
    share: 0.05,
    note: 'Pay order handed in at the bank',
  });
  if (E !== A) await slip(E, { daysAgo: 3, channel: 'bank_transfer', share: 0.04 });
  counts.pending = E !== A ? 4 : 3;
  console.log(
    `✔ Bank slips: ${counts.pending} pending · ${counts.approved} approved · ${counts.rejected} rejected · ${counts.withdrawn} withdrawn`,
  );

  // ── Profile change requests ──
  async function profileRequest(client, input, daysAgo) {
    const r = await portal.submitProfileRequest({
      org,
      user: client.user,
      input: zProfileRequest.parse(input),
      ctx: ctxOf(client.user),
    });
    await backdate(ProfileRequest, r.id, at(ago(daysAgo), 21, 10));
    return r;
  }
  {
    const r = await profileRequest(
      D,
      { altPhone: '01888777004', note: 'Second number for my wife' },
      15,
    );
    await review.approveProfileRequest({ org, user: admin, id: r.id, ctx });
  }
  {
    const r = await profileRequest(
      C,
      { phone: '01888999003', note: 'I changed my SIM — please update' },
      8,
    );
    await review.rejectProfileRequest({
      org,
      user: admin,
      id: r.id,
      ...zReason.parse({
        reason: 'A phone change needs your NID copy — please visit the office or call us.',
      }),
      ctx,
    });
  }
  await profileRequest(
    A,
    {
      presentAddress: 'Flat 6B, House 21, Road 11, Banani, Dhaka 1213',
      occupation: 'Senior Vice President',
      note: 'Moved in September',
    },
    2,
  );
  await profileRequest(
    B,
    {
      email: `${B.customer.name.split(' ')[0].toLowerCase()}.new@example.com`,
      organization: 'Grameenphone Ltd',
    },
    1,
  );
  console.log('✔ Profile requests: 2 pending · 1 approved · 1 rejected');

  // ── Online payments (SSLCommerz attempts) ──
  const CARDS = [
    ['VISA-Dutch Bangla', 'VISA', 'Dutch-Bangla Bank PLC'],
    ['BKASH-BKash', 'MOBILEBANKING', 'bKash Limited'],
    ['NAGAD-Nagad', 'MOBILEBANKING', 'Nagad'],
    ['MASTER-City Bank', 'MASTER', 'The City Bank PLC'],
  ];
  let tn = 0;
  async function online(client, { status, daysAgo, share, reviewReason = null, riskLevel = 0 }) {
    const { user, customer, booking } = client;
    const fresh = await Booking.findOne({ orgId, _id: booking._id }).lean();
    const left =
      scheduleTotals(fresh.schedule, today).outstanding -
      (await portal.pendingSlipTotal(orgId, booking._id));
    const amount = roundTk(Math.min(left * share, 150_000 * TK), 500);
    const created = at(ago(daysAgo), 19 + (tn % 3), 5 + tn * 7);
    const [cardType, cardBrand, cardIssuer] = CARDS[tn % CARDS.length];
    tn += 1;
    const tranId = newTranId();
    const reached = !['initiated', 'expired', 'cancelled'].includes(status);
    const tranDate = `${toDhakaDate(created)} ${String(19 + (tn % 3)).padStart(2, '0')}:${String((7 + tn * 7) % 60).padStart(2, '0')}:12`;
    const events = [{ at: created, source: 'init', status: 'INITIATED', note: null }];
    if (status === 'failed')
      events.push({
        at: new Date(created.getTime() + 95_000),
        source: 'fail',
        status: 'FAILED',
        note: 'Declined by issuer',
      });
    if (status === 'cancelled')
      events.push({
        at: new Date(created.getTime() + 60_000),
        source: 'cancel',
        status: 'CANCELLED',
        note: null,
      });
    if (status === 'expired')
      events.push({
        at: new Date(created.getTime() + 3.2 * 3_600_000),
        source: 'reconcile',
        status: 'NONE',
        note: null,
      });
    const doc = await OnlinePayment.create({
      orgId,
      tranId,
      bookingId: fresh._id,
      bookingNo: fresh.bookingNo,
      projectId: fresh.projectId,
      unitCode: fresh.unitCode,
      customerId: customer._id,
      customerName: customer.name,
      userId: new ObjectId(user.id),
      soldBy: fresh.soldBy ?? null,
      locale: customer.locale === 'en' ? 'en' : 'bn',
      amount,
      status: ['paid', 'rejected'].includes(status) ? 'review' : status,
      reviewReason: ['paid', 'rejected', 'review'].includes(status)
        ? (reviewReason ?? 'RISK')
        : null,
      gateway: {
        sessionKey: `SEEDSESSION${String(tn).padStart(6, '0')}`,
        gatewayUrl: null,
        ...(reached && {
          valId:
            status === 'failed' ? null : `SEEDVAL${Date.now().toString(36).toUpperCase()}${tn}`,
          bankTranId: status === 'failed' ? null : `BT${String(9_100_000 + tn * 913)}`,
          cardType,
          cardBrand,
          cardIssuer,
          riskLevel,
          riskTitle: riskLevel ? 'Risky Transaction' : 'Safe',
          tranDate,
          validatedAmount:
            status === 'failed'
              ? null
              : reviewReason === 'AMOUNT_MISMATCH'
                ? amount - 500 * TK
                : amount,
          validationStatus: status === 'failed' ? 'FAILED' : 'VALID',
          validatedAt: status === 'failed' ? null : new Date(created.getTime() + 70_000),
        }),
      },
      events:
        status === 'review'
          ? [
              ...events,
              {
                at: new Date(created.getTime() + 70_000),
                source: 'ipn',
                status: 'VALID',
                note: reviewReason,
              },
            ]
          : events,
      lastCheckedAt: new Date(created.getTime() + 3.3 * 3_600_000),
    });
    await backdate(OnlinePayment, doc._id, created);
    const id = String(doc._id);
    if (status === 'paid') {
      await approveReview({ orgId, user: admin, id, note: null, ctx });
      // Look like a straight gateway success (no staff review involved).
      await OnlinePayment.collection.updateOne(
        { _id: doc._id },
        {
          $set: {
            reviewReason: null,
            review: null,
            paidAt: new Date(created.getTime() + 75_000),
            events: [
              ...events,
              {
                at: new Date(created.getTime() + 70_000),
                source: 'success',
                status: 'VALID',
                note: null,
              },
              {
                at: new Date(created.getTime() + 75_000),
                source: 'success',
                status: 'PAID',
                note: null,
              },
            ],
          },
        },
      );
    }
    if (status === 'rejected') {
      await rejectReview({
        org,
        user: admin,
        id,
        reason: 'Card holder name differs from the buyer — refunded from the SSLCommerz panel.',
        ctx,
      });
    }
    return doc;
  }
  await online(A, { status: 'paid', daysAgo: 30, share: 0.05 });
  await online(D, { status: 'paid', daysAgo: 5, share: 0.04 });
  await online(B, {
    status: 'review',
    daysAgo: 4,
    share: 0.04,
    reviewReason: 'RISK',
    riskLevel: 1,
  });
  await online(C, {
    status: 'review',
    daysAgo: 3,
    share: 0.03,
    reviewReason: 'AMOUNT_MISMATCH',
  });
  await online(E, { status: 'failed', daysAgo: 7, share: 0.03 });
  await online(B, { status: 'cancelled', daysAgo: 11, share: 0.03 });
  await online(C, { status: 'expired', daysAgo: 16, share: 0.03 });
  await online(D, {
    status: 'rejected',
    daysAgo: 20,
    share: 0.02,
    riskLevel: 1,
  });
  console.log(
    '✔ Online payments: 2 paid · 2 in review · 1 rejected · 1 failed · 1 cancelled · 1 expired',
  );

  // ── Installment reminders: replay the daily run for the last 21 days, then one manual ──
  let runs = 0;
  for (let d = 21; d >= 0; d -= 1) {
    const day = ago(d);
    const mark = new ObjectId(); // ids made by this process only grow → "created by this run"
    const res = await runReminders(orgId, {
      now: at(day, 10, 30),
      force: true,
    });
    if (res?.sent) runs += 1;
    const logs = await ReminderLog.find({ orgId, _id: { $gt: mark } })
      .select('_id sms')
      .lean();
    for (const [i, l] of logs.entries()) {
      const when = at(day, 10, 30 + (i % 25));
      await backdate(ReminderLog, l._id, when, { runDate: day }); // deliver() stamps today
      if (l.sms?.smsId) await backdate(SmsMessage, l.sms.smsId, when);
    }
  }
  try {
    const target = await Booking.findOne({ orgId, _id: B.booking._id }).lean();
    await remindNow({ org, user: admin, booking: target, ctx });
  } catch (err) {
    if (!['ALREADY_REMINDED_TODAY', 'NOTHING_DUE'].includes(err.code)) throw err;
  }
  const reminderCount = await ReminderLog.countDocuments({
    orgId,
    _id: { $gte: seedStartId },
  });
  console.log(`✔ Reminder log: ${reminderCount} reminder(s) over ${runs} run day(s) + 1 manual`);

  // ── Nothing goes out: settle this run's SMS as delivered, drop queued SMS / e-mail jobs ──
  const smsRows = await SmsMessage.find({
    orgId,
    _id: { $gte: seedStartId },
    status: 'queued',
  })
    .select('_id createdAt')
    .sort({ createdAt: 1 })
    .lean();
  for (const [i, m] of smsRows.entries()) {
    const failed = i % 11 === 7; // a few realistic provider failures
    await SmsMessage.collection.updateOne(
      { _id: m._id },
      {
        $set: failed
          ? {
              status: 'failed',
              attempts: 3,
              failedAt: new Date(m.createdAt.getTime() + 9 * 60_000),
              error: {
                code: 'PROVIDER_ERROR',
                message: 'Gateway timeout (demo)',
              },
            }
          : {
              status: 'sent',
              attempts: 1,
              sentAt: new Date(m.createdAt.getTime() + 4_000),
              providerMessageId: `DEMO${String(m._id).slice(-10).toUpperCase()}`,
            },
      },
    );
  }
  const dropped = await Job.collection.deleteMany({
    orgId,
    _id: { $gte: seedStartId },
    type: { $in: ['sms.send', 'email.send', 'documents.emailReceipt'] },
    status: 'queued',
  });
  console.log(
    `✔ SMS log: ${smsRows.length} message(s) settled · ${dropped.deletedCount} outgoing job(s) removed`,
  );

  console.log('\nTest guide');
  console.log('  Staff (admin): Payment slips · Online payments · Profile requests · Reminders.');
  console.log('  Portal: sign in with one of these phones and the password above —');
  for (const x of live)
    console.log(`    ${x.customer.phone.replace('+880', '0')}  ${x.customer.name}`);
  console.log(`  Invited only (no password yet): ${clients.at(-1).customer.name}`);
} catch (err) {
  if (!err.skip) throw err;
} finally {
  if (restore)
    await restore().catch((e) => console.error('✖ Could not restore account settings:', e.message));
  await disconnectDB();
}
