// Demo SALES data for development: customers, bank accounts, payment plans and ~14 bookings in
// every state the F5 screens show — paid up, overdue in each aging bucket, PDC series (cleared,
// deposited, bounced, returned, post-dated), allotted / registered / handed over, transferred,
// cancelled with partial and full refund, charges (added + waived) and a called milestone.
//
//   npm run seed:sales           # create (skipped when demo customers already exist)
//
// Everything goes through the real services (validation schemas, counters, ledger, documents,
// audit), exactly as the API would write it. There is deliberately NO --reset: receipts, refunds
// and the ledger are permanent (ARCHITECTURE: append-only), so the only clean slate is a fresh
// database. Demo customers are recognised by phone (+8801888xxxxxx, and +447700900xxx — a UK
// range reserved for fiction).
//
// Needs `npm run seed` and `npm run seed:demo` first (projects LVR / UGC / PSC with priced
// units); `npm run seed:crm` is optional (bookings are then also sold by Nadia and Sumi).
// While it runs, the receipt back-date limit is lifted to 366 days and receipt SMS is switched
// off; both settings are put back at the end. Never run it on production.
import { parseArgs } from 'node:util';
import { env } from '#config/env.js';
import { connectDB, disconnectDB } from '#config/db.js';
import { permissionsFor } from '#shared/auth/permissions.js';
import { addDays, todayDhaka } from '#shared/utils/dhakaDate.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { User } from '#modules/users/user.model.js';
import { Project } from '#modules/projects/project.model.js';
import { Unit } from '#modules/units/unit.model.js';
import { Customer } from '#modules/customers/customer.model.js';
import { PaymentPlan } from '#modules/bookings/paymentPlan.model.js';
import { BankAccount } from '#modules/accounts/bankAccount.model.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import { zBankCreate, zPayment } from '#modules/accounts/accounts.validation.js';
import { createCustomer } from '#modules/customers/customer.service.js';
import { zCustomerCreate } from '#modules/customers/customer.validation.js';
import { createPlan } from '#modules/bookings/plan.service.js';
import {
  addPayment,
  createBooking,
  getBookingDetail,
  previewBooking,
} from '#modules/bookings/booking.service.js';
import {
  zBookingCreate,
  zBookingPreview,
  zPlanCreate,
} from '#modules/bookings/booking.validation.js';
import * as cheques from '#modules/bookings/cheque.service.js';
import * as life from '#modules/bookings/lifecycle.service.js';
import {
  zAllot,
  zCallItem,
  zCancel,
  zChargeCreate,
  zChequeBounce,
  zChequeClear,
  zChequeCreate,
  zChequeDeposit,
  zChequeReturn,
  zRefund,
  zRegister,
  zTransfer,
} from '#modules/bookings/lifecycle.validation.js';

parseArgs({ options: {} }); // no options — rejects typos such as --reset

if (env.isProd) {
  console.error('\n✖ seed:sales refuses to run with NODE_ENV=production\n');
  process.exit(1);
}

const TK = 100;
const LAKH = 100_000 * TK;
const TODAY = todayDhaka();
const ago = (days) => addDays(TODAY, -days);
const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);
const DEMO_PHONE = /^\+(8801888|447700900)/;

// ── demo content ────────────────────────────────────────────────────────────────

const CUSTOMERS = {
  c1: {
    name: 'Mahbub Alam',
    nameBn: 'মাহবুব আলম',
    fatherName: 'Abdul Alam',
    occupation: 'Banker',
    organization: 'Eastern Bank PLC',
    email: 'mahbub.alam@example.com',
    presentAddress: 'House 12, Road 5, Dhanmondi, Dhaka',
    locale: 'bn',
  },
  c2: {
    name: 'Farzana Alam',
    nameBn: 'ফারজানা আলম',
    occupation: 'Doctor',
    email: 'farzana.alam@example.com',
    presentAddress: 'House 12, Road 5, Dhanmondi, Dhaka',
  },
  c3: {
    name: 'Tanvir Ahmed',
    nameBn: 'তানভীর আহমেদ',
    occupation: 'Business',
    organization: 'Ahmed Traders',
    presentAddress: 'Sector 7, Uttara, Dhaka',
    locale: 'bn',
  },
  c4: {
    name: 'Nusrat Jahan',
    nameBn: 'নুসরাত জাহান',
    occupation: 'Teacher',
    presentAddress: 'Mirpur 10, Dhaka',
    locale: 'bn',
  },
  c5: {
    name: 'Shafiqul Islam',
    nameBn: 'শফিকুল ইসলাম',
    occupation: 'Engineer',
    email: 'shafiq@example.com',
    presentAddress: 'Agrabad, Chattogram',
  },
  c6: {
    name: 'Rokeya Sultana',
    nameBn: 'রোকেয়া সুলতানা',
    occupation: 'Retired',
    presentAddress: 'Sector 13, Uttara, Dhaka',
    locale: 'bn',
  },
  c7: {
    name: 'Imran Hossain',
    nameBn: 'ইমরান হোসেন',
    occupation: 'Software engineer',
    email: 'imran.h@example.com',
    presentAddress: 'Banani, Dhaka',
    locale: 'en',
  },
  c8: {
    name: 'Abul Kalam Azad',
    nameBn: 'আবুল কালাম আজাদ',
    occupation: 'Business',
    organization: 'Azad Garments',
    presentAddress: 'Narayanganj',
    locale: 'bn',
  },
  c9: {
    name: 'Sharmin Akter',
    nameBn: 'শারমিন আক্তার',
    occupation: 'Government service',
    presentAddress: 'Khilgaon, Dhaka',
    locale: 'bn',
  },
  c10: {
    name: 'Kamrul Hasan',
    nameBn: 'কামরুল হাসান',
    occupation: 'Business',
    presentAddress: 'Gazipur',
    locale: 'bn',
  },
  c11: {
    name: 'Mitu Rahman',
    nameBn: 'মিতু রহমান',
    occupation: 'Architect',
    email: 'mitu.r@example.com',
    presentAddress: 'Mohammadpur, Dhaka',
  },
  c12: {
    name: 'Jahid Hasan',
    nameBn: 'জাহিদ হাসান',
    occupation: 'Pharmacist',
    presentAddress: 'Bashundhara R/A, Dhaka',
    locale: 'bn',
  },
  c13: {
    name: 'Sadia Islam',
    nameBn: 'সাদিয়া ইসলাম',
    occupation: 'Lawyer',
    email: 'sadia.islam@example.com',
    presentAddress: 'Gulshan 1, Dhaka',
    locale: 'en',
  },
  c14: {
    name: 'Mostafizur Rahman',
    nameBn: 'মোস্তাফিজুর রহমান',
    occupation: 'Business',
    presentAddress: 'Sylhet',
    locale: 'bn',
  },
  c15: {
    name: 'Rubina Khatun',
    nameBn: 'রুবিনা খাতুন',
    occupation: 'Homemaker',
    presentAddress: 'Savar, Dhaka',
    locale: 'bn',
  },
  c16: {
    name: 'Habibur Rahman',
    nameBn: 'হাবিবুর রহমান',
    occupation: 'Restaurant owner',
    email: 'habib.uk@example.com',
    foreignAddress: '24 Brick Lane, London E1 6RF, UK',
    nationality: 'Bangladeshi',
    locale: 'en',
    nrb: true,
  },
  c17: {
    name: 'Lutfun Nahar',
    nameBn: 'লুৎফুন নাহার',
    occupation: 'Teacher',
    presentAddress: 'Rajshahi',
    locale: 'bn',
  },
};
// Customers whose booking is sold by an executive must be created by that executive (access).
const OWNER = { c3: 'nadia', c4: 'sumi', c15: 'sumi' };

const PLANS = {
  monthly: {
    name: '24 months · 20% down · roof casting',
    nameBn: '২৪ মাস · ২০% ডাউন · ছাদ ঢালাই',
    description: 'Fixed booking money, down payment in 15 days, 24 monthly installments.',
    sortOrder: 10,
    spec: {
      bookingMoney: { type: 'fixed', value: 5 * LAKH },
      downPayment: { type: 'percent', value: 2000, dueAfterDays: 15 },
      installments: { count: 24, everyMonths: 1 },
      milestones: [
        { key: 'roof', label: 'Roof casting', labelBn: 'ছাদ ঢালাই', type: 'percent', value: 500 },
      ],
      handover: { type: 'percent', value: 1000 },
    },
  },
  quarterly: {
    name: 'Plots · 8 quarterly installments',
    nameBn: 'প্লট · ৮টি ত্রৈমাসিক কিস্তি',
    description: '10% booking, 20% down in 30 days, 8 quarterly installments, 5% at registration.',
    sortOrder: 11,
    spec: {
      bookingMoney: { type: 'percent', value: 1000 },
      downPayment: { type: 'percent', value: 2000, dueAfterDays: 30 },
      installments: { count: 8, everyMonths: 3 },
      handover: { type: 'percent', value: 500 },
    },
  },
  oneTime: {
    name: 'One-time · balance at handover',
    nameBn: 'এককালীন · বাকি হস্তান্তরে',
    description: '10% booking money, the rest when the unit is handed over.',
    sortOrder: 12,
    spec: { bookingMoney: { type: 'percent', value: 1000 }, handover: { type: 'balance' } },
  },
};

const BANKS = [
  {
    name: 'BRAC – Collection',
    bankName: 'BRAC Bank PLC',
    branch: 'Gulshan',
    accountName: 'Demo Developers Ltd',
    accountNo: '1501-DEMO-0001',
    routingNo: '060261726',
  },
  {
    name: 'DBBL – Escrow',
    bankName: 'Dutch-Bangla Bank PLC',
    branch: 'Motijheel',
    accountName: 'Demo Developers Ltd',
    accountNo: '105-DEMO-0002',
    routingNo: '090274721',
  },
];

// ── run ─────────────────────────────────────────────────────────────────────────

await connectDB({ retries: 2 });
let restore = null;
try {
  const org = await getCurrentOrg();
  const orgId = org._id;

  if (await Customer.exists({ orgId, phone: DEMO_PHONE }).setOptions({ withDeleted: true })) {
    console.log(
      '• Demo customers already exist — nothing created. Sales records are permanent; use a fresh database for a clean demo.',
    );
    throw Object.assign(new Error('skip'), { skip: true });
  }

  // People
  const asUser = (u) => ({
    id: String(u._id),
    orgId,
    role: u.role,
    name: u.name,
    email: u.email,
    permissions: permissionsFor(u.role),
  });
  const adminDoc = await User.findOne({ orgId, role: 'admin', status: 'active' })
    .sort({ createdAt: 1 })
    .lean();
  if (!adminDoc) throw new Error('No active admin — run `npm run seed` first.');
  const admin = asUser(adminDoc);
  const staff = { admin };
  for (const [key, email] of [
    ['nadia', 'nadia@demo.primeplot.test'],
    ['sumi', 'sumi@demo.primeplot.test'],
  ]) {
    const u = await User.findOne({ orgId, email, status: 'active' }).lean();
    staff[key] = u ? asUser(u) : admin;
  }
  const ctxOf = (user) => ({
    orgId,
    actor: { id: user.id, role: user.role, name: user.name, kind: 'user' },
    ip: null,
    userAgent: 'seed-sales',
    requestId: null,
  });
  const ctx = ctxOf(admin);

  // Projects (from seed:demo)
  const projects = {};
  for (const code of ['LVR', 'UGC', 'PSC']) {
    projects[code] = await Project.findOne({ orgId, code }).select('_id name code kind').lean();
    if (!projects[code])
      throw new Error(`Project ${code} not found — run \`npm run seed:demo\` first.`);
  }
  const usedUnits = new Set();
  const freeUnits = async (code) =>
    (
      await Unit.find({ orgId, projectId: projects[code]._id, status: 'available' })
        .sort({ code: 1 })
        .select('_id code')
        .lean()
    ).filter((u) => !usedUnits.has(String(u._id)));

  // Settings: allow back-dated receipts, no SMS while seeding (restored in `finally`).
  const before = accounts.toAccountSettings(await accounts.getAccountSettings(orgId));
  const tmp = await accounts.updateAccountSettings({
    orgId,
    patch: {
      version: before.version,
      receiptBackdateDays: 366,
      notify: { receiptSms: false, receiptEmail: false },
    },
    ctx,
  });
  restore = async () =>
    accounts.updateAccountSettings({
      orgId,
      patch: {
        version: tmp.version,
        receiptBackdateDays: before.receiptBackdateDays,
        notify: before.notify,
      },
      ctx,
    });

  // Bank accounts
  const bank = [];
  for (const b of BANKS) {
    const found = await BankAccount.findOne({ orgId, accountNo: b.accountNo }).lean();
    bank.push(
      found
        ? String(found._id)
        : (await accounts.createBankAccount({ orgId, input: zBankCreate.parse(b), ctx })).id,
    );
  }
  console.log(`✔ Bank accounts: ${BANKS.map((b) => b.name).join(', ')}`);

  // Payment plans (company-wide)
  const plan = {};
  for (const [key, p] of Object.entries(PLANS)) {
    const found = await PaymentPlan.findOne({ orgId, projectId: null, name: p.name }).lean();
    plan[key] = found
      ? String(found._id)
      : (
          await createPlan({
            orgId,
            input: zPlanCreate.parse({ ...p, projectId: null, active: true }),
            ctx,
          })
        ).id;
  }
  console.log(
    `✔ Payment plans: ${Object.values(PLANS)
      .map((p) => p.name)
      .join(' | ')}`,
  );

  // Customers
  const cust = {};
  let n = 0;
  for (const [key, c] of Object.entries(CUSTOMERS)) {
    n += 1;
    const { nrb, ...fields } = c;
    const input = {
      ...fields,
      phone: nrb
        ? `+447700900${String(n).padStart(3, '0')}`
        : `+8801888${String(n).padStart(6, '0')}`,
      nationality: fields.nationality ?? 'Bangladeshi',
      ...(nrb
        ? { passportNo: `BX${String(1_000_000 + n)}` }
        : { nid: String(1_990_000_000 + n * 7919) }),
    };
    const by = staff[OWNER[key]] ?? admin;
    cust[key] = (
      await createCustomer({ orgId, user: by, input: zCustomerCreate.parse(input), ctx: ctxOf(by) })
    ).id;
  }
  console.log(`✔ Customers: ${n} (Habibur Rahman has no booking)`);

  // ── helpers ──
  let modeTurn = 0;
  let ref = 0;
  const payment = (amount, date) => {
    const mode = ['cash', 'bank_transfer', 'pay_order', 'bank_transfer'][modeTurn++ % 4];
    ref += 1;
    return zPayment.parse({
      amount,
      date,
      mode,
      ...(mode === 'bank_transfer' && {
        bankAccountId: bank[ref % 2],
        reference: `NPSB-${20260000 + ref}`,
      }),
      ...(mode === 'pay_order' && {
        instrumentNo: `PO-${400000 + ref}`,
        instrumentBank: 'Sonali Bank PLC',
      }),
    });
  };
  const detail = (id) => getBookingDetail(orgId, admin, id);
  const pay = async (id, amount, date) =>
    addPayment({
      org,
      user: admin,
      bookingId: id,
      input: payment(amount, date),
      idempotencyKey: null,
      ctx,
    });

  /** Pay every contract item due on or before `upTo`, each on its due date. */
  async function payDue(id, upTo, { skipLast = 0 } = {}) {
    const b = await detail(id);
    const due = b.schedule
      .filter((i) => i.code !== 'charge' && i.dueDate && i.dueDate <= upTo && i.remaining > 0)
      .sort((x, y) => (x.dueDate < y.dueDate ? -1 : x.dueDate > y.dueDate ? 1 : x.seq - y.seq));
    const list = skipLast ? due.slice(0, Math.max(0, due.length - skipLast)) : due;
    for (const i of list) await pay(id, i.remaining, maxDate(i.dueDate, b.bookingDate));
    return list.length;
  }

  /** Book the first free, priced unit of a project; booking money paid in cash or by cheque. */
  async function book(
    code,
    { plan: planKey, customer, seller = admin, age, cheque = null, extra = {} },
  ) {
    const bookingDate = ago(age);
    for (const u of await freeUnits(code)) {
      const base = { unitId: String(u._id), planId: plan[planKey], bookingDate, ...extra };
      let pv;
      try {
        pv = await previewBooking({
          orgId,
          user: seller,
          input: zBookingPreview.parse({
            unitId: base.unitId,
            planId: base.planId,
            bookingDate,
            ...(extra.discount && { discount: extra.discount }),
          }),
        });
      } catch (err) {
        if (err.code === 'PRICE_NOT_SET') continue;
        throw err;
      }
      if (pv.warnings.length) continue;
      usedUnits.add(base.unitId);
      const pmt = cheque
        ? {
            mode: 'cheque',
            amount: pv.bookingMoney,
            chequeNo: cheque.no,
            bank: cheque.bank,
            chequeDate: cheque.date ?? bookingDate,
          }
        : { mode: 'cash', amount: pv.bookingMoney };
      const input = zBookingCreate.parse({ ...base, customerId: cust[customer], payment: pmt });
      const { booking } = await createBooking({
        org,
        user: seller,
        input,
        idempotencyKey: null,
        ctx: ctxOf(seller),
      });
      return booking;
    }
    throw new Error(`No free priced unit left in ${code}`);
  }

  const chequeIn = (b, c) =>
    cheques.receiveCheque({
      org,
      user: admin,
      bookingId: b.id,
      input: zChequeCreate.parse(c),
      ctx,
    });
  const deposit = (c, date, acc = 0) =>
    cheques.depositCheque({
      org,
      user: admin,
      chequeId: c.id,
      input: zChequeDeposit.parse({ date, bankAccountId: bank[acc] }),
      ctx,
    });
  const clear = (c, date) =>
    cheques.clearCheque({
      org,
      user: admin,
      chequeId: c.id,
      input: zChequeClear.parse({ date }),
      ctx,
    });
  const stage = async (fn, b, input) =>
    (await life[fn]({ org, user: admin, bookingId: b.id, input, ctx })).booking;

  // ── scenarios ──
  const rows = [];
  const scenario = async (label, fn) => {
    try {
      const b = await fn();
      rows.push([b.bookingNo, label]);
      console.log(`✔ ${b.bookingNo.padEnd(14)} ${label}`);
    } catch (err) {
      console.error(`✖ ${label}: ${err.code ?? ''} ${err.message}`);
    }
  };

  await scenario('Paid up to date, allotted · co-applicant, nominees, discount', async () => {
    const b = await book('LVR', {
      plan: 'monthly',
      customer: 'c1',
      age: 330,
      extra: {
        discount: { amount: 2 * LAKH, reason: 'Early-bird offer' },
        coApplicantIds: [cust.c2],
        nominees: [
          { name: 'Ayaan Alam', relation: 'Son', sharePct: 60 },
          { name: 'Inaya Alam', relation: 'Daughter', sharePct: 40 },
        ],
      },
    });
    await payDue(b.id, TODAY);
    await stage(
      'allot',
      b,
      zAllot.parse({ date: ago(300), note: 'Allotment letter handed over at the office' }),
    );
    return b;
  });

  await scenario('Overdue 1–60 days (last two installments unpaid) · sold by Nadia', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c3', seller: staff.nadia, age: 200 });
    await payDue(b.id, TODAY, { skipLast: 2 });
    return b;
  });

  await scenario('Down payment overdue 1–30 days · sold by Sumi', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c4', seller: staff.sumi, age: 40 });
    return b;
  });

  await scenario('Only booking money paid — overdue in every bucket up to 90+ days', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c5', age: 140 });
    return b;
  });

  await scenario('Fully paid · allotted → registered → handed over', async () => {
    const b = await book('UGC', { plan: 'oneTime', customer: 'c6', age: 250 });
    const d = await detail(b.id);
    const ho = d.schedule.find((i) => i.code === 'handover');
    await life.callItem({
      orgId,
      user: admin,
      bookingId: b.id,
      itemId: ho.id,
      input: zCallItem.parse({ dueDate: ago(200), note: 'Flat ready — balance called' }),
      ctx,
    });
    await payDue(b.id, TODAY);
    await stage('allot', b, zAllot.parse({ date: ago(195) }));
    await stage(
      'register',
      b,
      zRegister.parse({
        date: ago(120),
        deedNo: '4471/2026',
        subRegistryOffice: 'Uttara Sub-Registry Office',
      }),
    );
    await stage(
      'handover',
      b,
      zAllot.parse({ date: ago(90), note: 'Keys and possession letter handed over' }),
    );
    return b;
  });

  await scenario('Booking money by cheque — in hand, to bank now', async () => {
    return book('UGC', {
      plan: 'oneTime',
      customer: 'c7',
      age: 12,
      cheque: { no: '5512309', bank: 'City Bank PLC', date: ago(5) },
    });
  });

  await scenario('PDC series: cleared, bounced (+fee), returned, two post-dated', async () => {
    const b = await book('PSC', { plan: 'quarterly', customer: 'c8', age: 200 });
    await payDue(b.id, ago(150)); // booking + down payment
    const d = await detail(b.id);
    const inst = d.schedule.filter((i) => i.code === 'installment').slice(0, 4);
    const banks = [
      'Islami Bank Bangladesh PLC',
      'Eastern Bank PLC',
      'Islami Bank Bangladesh PLC',
      'Eastern Bank PLC',
    ];
    const got = [];
    for (const [k, i] of inst.entries()) {
      got.push(
        await chequeIn(b, {
          chequeNo: `33100${k + 1}`,
          bank: banks[k],
          branch: 'Narayanganj',
          chequeDate: i.dueDate,
          amount: i.amount,
          receivedDate: ago(160),
        }),
      );
    }
    const past = got.filter((c) => c.chequeDate <= TODAY);
    if (past[0]) {
      await deposit(past[0], past[0].chequeDate);
      await clear(past[0], minDate(addDays(past[0].chequeDate, 3), TODAY));
    }
    if (past[1]) {
      await deposit(past[1], past[1].chequeDate, 1);
      await cheques.bounceCheque({
        org,
        user: admin,
        chequeId: past[1].id,
        input: zChequeBounce.parse({
          date: minDate(addDays(past[1].chequeDate, 2), TODAY),
          reason: 'Insufficient funds',
          fee: 500 * TK,
        }),
        ctx,
      });
    }
    const hand = d.schedule.find((i) => i.code === 'handover');
    const extra = await chequeIn(b, {
      chequeNo: '7790012',
      bank: 'Sonali Bank PLC',
      chequeDate: addDays(TODAY, 400),
      amount: Math.min(hand.amount, 2 * LAKH),
      receivedDate: ago(30),
    });
    await cheques.returnCheque({
      org,
      user: admin,
      chequeId: extra.id,
      input: zChequeReturn.parse({ reason: 'Buyer will pay this part by pay order instead' }),
      ctx,
    });
    return b;
  });

  await scenario('Down payment cheque deposited, waiting to clear', async () => {
    const b = await book('PSC', { plan: 'quarterly', customer: 'c9', age: 45 });
    const d = await detail(b.id);
    const down = d.schedule.find((i) => i.code === 'down_payment');
    const c = await chequeIn(b, {
      chequeNo: '908877',
      bank: 'Pubali Bank PLC',
      chequeDate: down.dueDate,
      amount: down.amount,
      receivedDate: ago(40),
    });
    await deposit(c, minDate(down.dueDate, TODAY));
    return b;
  });

  await scenario('Cancelled · policy deduction · half refunded', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c10', age: 120 });
    await payDue(b.id, ago(80));
    const after = await life.cancel({
      org,
      user: admin,
      bookingId: b.id,
      input: zCancel.parse({ reason: 'Buyer is moving abroad', date: ago(20) }),
      ctx,
    });
    const half = Math.floor(after.cancellation.refundable / 2);
    if (half > 0) {
      await life.addRefund({
        org,
        user: admin,
        bookingId: b.id,
        input: zRefund.parse({
          amount: half,
          mode: 'pay_order',
          instrumentNo: 'PO-778120',
          date: ago(10),
          note: 'First part of the refund',
        }),
        ctx,
      });
    }
    return b;
  });

  await scenario('Cancelled · deduction waived · fully refunded', async () => {
    const b = await book('PSC', { plan: 'oneTime', customer: 'c11', age: 90 });
    const after = await life.cancel({
      org,
      user: admin,
      bookingId: b.id,
      input: zCancel.parse({
        reason: 'Plot boundary dispute — company cancelled',
        date: ago(30),
        deductionAmount: 0,
        overrideReason: 'Cancelled by the company',
      }),
      ctx,
    });
    await life.addRefund({
      org,
      user: admin,
      bookingId: b.id,
      input: zRefund.parse({
        amount: after.cancellation.refundable,
        mode: 'bank_transfer',
        bankAccountId: bank[0],
        reference: 'BEFTN-99120',
        date: ago(25),
      }),
      ctx,
    });
    return b;
  });

  await scenario('Transferred to a new holder', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c12', age: 70 });
    await payDue(b.id, TODAY);
    await life.transfer({
      org,
      user: admin,
      bookingId: b.id,
      input: zTransfer.parse({
        toCustomerId: cust.c13,
        date: ago(5),
        note: 'Sold to a relative',
        waiveFeeReason: 'Family transfer',
      }),
      ctx,
    });
    return b;
  });

  await scenario('Charges (added + waived) and a called milestone', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c14', age: 150 });
    await payDue(b.id, TODAY);
    await life.addCharge({
      orgId,
      user: admin,
      bookingId: b.id,
      input: zChargeCreate.parse({
        kind: 'utility',
        label: 'Gas connection',
        labelBn: 'গ্যাস সংযোগ',
        amount: 35_000 * TK,
        dueDate: addDays(TODAY, 20),
      }),
      ctx,
    });
    const withDelay = await life.addCharge({
      orgId,
      user: admin,
      bookingId: b.id,
      input: zChargeCreate.parse({
        kind: 'delay',
        label: 'Delay charge — late down payment',
        labelBn: 'বিলম্ব মাশুল',
        amount: 5_000 * TK,
        dueDate: TODAY,
      }),
      ctx,
    });
    const delay = withDelay.schedule.find((i) => i.code === 'charge' && i.chargeKind === 'delay');
    await life.waiveCharge({
      orgId,
      user: admin,
      bookingId: b.id,
      itemId: delay.id,
      reason: 'Waived as goodwill — first delay',
      ctx,
    });
    const roof = withDelay.schedule.find((i) => i.milestoneKey === 'roof');
    if (roof)
      await life.callItem({
        orgId,
        user: admin,
        bookingId: b.id,
        itemId: roof.id,
        input: zCallItem.parse({ dueDate: addDays(TODAY, 10), note: 'Roof casting done' }),
        ctx,
      });
    return b;
  });

  await scenario('Booked today · sold by Nadia', async () => {
    const b = await book('LVR', { plan: 'monthly', customer: 'c3', seller: staff.nadia, age: 0 });
    return b;
  });

  await scenario('Plot booked 10 days ago · sold by Sumi', async () => {
    return book('PSC', { plan: 'quarterly', customer: 'c15', seller: staff.sumi, age: 10 });
  });

  await scenario('Allotted with dues outstanding (warning case)', async () => {
    const b = await book('UGC', { plan: 'monthly', customer: 'c17', age: 25 });
    await stage('allot', b, zAllot.parse({ date: ago(2) }));
    return b;
  });

  console.log(`\n${rows.length} booking(s) created.`);
  console.log('Test guide (sign in as the admin):');
  console.log(
    '  Bookings → open any row above; Cheques → "Open" / "Bounced" views; Reports → all three tabs.',
  );
  console.log(
    '  Customer without a booking: Habibur Rahman (NRB, UK number). Co-applicant: Farzana Alam.',
  );
  console.log(
    '  Executive view: sumi@demo.primeplot.test sees only her two bookings (needs seed:crm).',
  );
} catch (err) {
  if (!err.skip) throw err;
} finally {
  if (restore)
    await restore().catch((e) => console.error('✖ Could not restore account settings:', e.message));
  await disconnectDB();
}
