import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fiscalYear, todayDhaka, addDays } from '#shared/utils/dhakaDate.js';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

/** B4.1 — customers, plans, bookings, receipts, reversal, ledger integrity. */
const TK = 100;
const LAKH = 100_000 * TK;
let app;
let Unit;
let Receipt;
let LedgerEntry;
let Lead;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Unit } = await import('#modules/units/unit.model.js'));
  ({ Receipt } = await import('#modules/accounts/receipt.model.js'));
  ({ LedgerEntry } = await import('#modules/accounts/ledgerEntry.model.js'));
  ({ Lead } = await import('#modules/leads/lead.model.js'));
});
afterAll(stopDb);

let org;
let admin;
let manager;
let exec;
let exec2;
let A; // admin
let M; // manager
let E; // executive
let E2; // another executive
let project;
let units;
let plan;
let customer;
const FY = () => fiscalYear(todayDhaka()).short;

const PLAN_SPEC = {
  bookingMoney: { type: 'fixed', value: 5 * LAKH },
  downPayment: { type: 'percent', value: 2000, dueAfterDays: 15 },
  installments: { count: 24, everyMonths: 1 },
  handover: { type: 'percent', value: 1000 },
};

beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  manager = await createUser(org, { role: 'sales_manager' });
  exec = await createUser(org, { role: 'sales_executive' });
  exec2 = await createUser(org, { role: 'sales_executive' });
  A = await loginAgent(request, app, admin);
  M = await loginAgent(request, app, manager);
  E = await loginAgent(request, app, exec);
  E2 = await loginAgent(request, app, exec2);

  const p = await A.post('/api/v1/projects').send({
    name: 'Lake View Residency',
    kind: 'apartment',
    code: 'lvr',
  });
  expect(p.status).toBe(201);
  expect(p.body.data.code).toBe('LVR');
  const b = await A.post(`/api/v1/projects/${p.body.data.id}/blocks`).send({
    kind: 'building',
    code: 'A',
    name: 'Tower A',
    lowestFloor: 0,
    highestFloor: 10,
  });
  const priced = await A.put(`/api/v1/projects/${p.body.data.id}/pricing`).send({
    version: p.body.data.version,
    pricing: { ratePerSqft: 8_000 * TK, parkingPerSlot: 3 * LAKH },
  });
  expect(priced.status).toBe(200);
  project = priced.body.data;
  units = [];
  for (const pos of ['A', 'B', 'C', 'D']) {
    const u = await A.post(`/api/v1/projects/${project.id}/units`).send({
      blockId: b.body.data.id,
      floor: 5,
      position: pos,
      saleableSqft: 1250,
      parkingSlots: 1,
    });
    expect(u.status).toBe(201);
    units.push(u.body.data);
  }
  // 1250 × 8,000 + 3,00,000 = ৳1,03,00,000
  expect(units[0].listPrice).toBe(1_03_00_000 * TK);

  const pl = await M.post('/api/v1/payment-plans').send({ name: '24 months', spec: PLAN_SPEC });
  expect(pl.status).toBe(201);
  plan = pl.body.data;

  const c = await E.post('/api/v1/customers').send({
    name: 'Abdur Rahim',
    phone: '01712345678',
    nid: '1234567890',
    email: 'rahim@example.com',
  });
  expect(c.status).toBe(201);
  customer = c.body.data;
});

const cash = (amount) => ({ amount, mode: 'cash' });
const book = (agent, body = {}, headers = {}) => {
  let req = agent.post('/api/v1/bookings');
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({
    unitId: units[0].id,
    customerId: customer.id,
    planId: plan.id,
    payment: cash(5 * LAKH),
    ...body,
  });
};

async function ledgerOk(agent, bookingId) {
  const l = await agent.get(`/api/v1/bookings/${bookingId}/ledger`);
  expect(l.status).toBe(200);
  expect(l.body.data.integrity).toMatchObject({ ok: true, mismatchedItems: [] });
  return l.body.data;
}

describe('customers', () => {
  it('numbers, duplicate NID, visibility and search', async () => {
    expect(customer.customerNo).toBe('C-000001');
    expect(customer.phone).toBe('+8801712345678');
    const dup = await E.post('/api/v1/customers').send({
      name: 'Someone',
      phone: '01812345678',
      nid: '1234567890',
    });
    expect(dup.status).toBe(409);
    expect((await E2.get(`/api/v1/customers/${customer.id}`)).status).toBe(404);
    expect((await M.get(`/api/v1/customers/${customer.id}`)).status).toBe(200);
    const found = await E.get('/api/v1/customers?q=01712345678');
    expect(found.body.data.map((c) => c.id)).toEqual([customer.id]);
    expect((await E2.get('/api/v1/customers?q=Rahim')).body.data).toHaveLength(0);
    const bad = await E.post('/api/v1/customers').send({ name: 'X Y', phone: '123456789' });
    expect(bad.status).toBe(400);
  });
});

describe('booking', () => {
  it('preview: price, cap, schedule — nothing written', async () => {
    const res = await E.post('/api/v1/bookings/preview').send({
      unitId: units[0].id,
      planId: plan.id,
      discount: { amount: 50_000 * TK, reason: 'Fair visit' },
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.price).toMatchObject({
      listTotal: 1_03_00_000 * TK,
      baseAmount: 1_00_00_000 * TK,
      discount: 50_000 * TK,
      contractTotal: 1_02_50_000 * TK,
    });
    expect(d.discountCap).toEqual({ bps: 100, maxAmount: 1_00_000 * TK });
    expect(d.schedule.reduce((s, i) => s + i.amount, 0)).toBe(1_02_50_000 * TK);
    expect(d.bookingMoney).toBe(5 * LAKH);
    expect((await Unit.findOne({ orgId: org._id, _id: units[0].id }).lean()).status).toBe(
      'available',
    );
  });

  it('executive books a held unit with cash booking money; lead → won', async () => {
    const lead = await E.post('/api/v1/leads').send({ name: 'Abdur Rahim', phone: '01712345678' });
    expect(lead.status).toBe(201);
    expect((await E.post(`/api/v1/units/${units[0].id}/hold`).send({})).status).toBe(200);

    const res = await book(E, { leadId: lead.body.data.id, expectedTotal: 1_03_00_000 * TK });
    expect(res.status).toBe(201);
    const bk = res.body.data;
    expect(bk.bookingNo).toBe('LVR-BK-00001');
    expect(bk.price.contractTotal).toBe(1_03_00_000 * TK);
    expect(bk.schedule.reduce((s, i) => s + i.amount, 0)).toBe(1_03_00_000 * TK);
    expect(bk.schedule[0]).toMatchObject({ code: 'booking_money', paid: 5 * LAKH, status: 'paid' });
    expect(bk.totals).toMatchObject({ paid: 5 * LAKH, outstanding: 98 * LAKH });
    expect(bk.receipts).toHaveLength(1);
    expect(bk.receipts[0]).toMatchObject({
      receiptNo: `LVR-${FY()}-000001`,
      amount: 5 * LAKH,
      mode: 'cash',
      context: 'booking',
      amountInWords: { en: 'Five Lakh Taka Only', bn: 'পাঁচ লক্ষ টাকা মাত্র' },
    });

    const u = await Unit.findOne({ orgId: org._id, _id: units[0].id }).lean();
    expect(u).toMatchObject({ status: 'booked', hold: null });
    const l = await Lead.findOne({ orgId: org._id, _id: lead.body.data.id }).lean();
    expect(l.status).toBe('won');
    const acts = (await E.get(`/api/v1/leads/${lead.body.data.id}/activities`)).body.data;
    expect(acts.map((a) => a.type)).toContain('booking');
    await ledgerOk(E, bk.id);

    // Seller sees the booking; another executive does not.
    expect((await E.get(`/api/v1/bookings/${bk.id}`)).status).toBe(200);
    expect((await E2.get(`/api/v1/bookings/${bk.id}`)).status).toBe(404);
    expect((await E2.get('/api/v1/bookings')).body.data).toHaveLength(0);
    expect((await M.get('/api/v1/bookings')).body.data).toHaveLength(1);
  });

  it('booking money: required, short, waived only by a manager', async () => {
    const none = await book(E, { payment: undefined });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('BOOKING_MONEY_REQUIRED');
    const short = await book(E, { payment: cash(4 * LAKH) });
    expect(short.body.error.code).toBe('BOOKING_MONEY_SHORT');
    const waiveExec = await book(E, { payment: undefined, waiveReason: 'Cheque tomorrow' });
    expect(waiveExec.status).toBe(403);
    expect(waiveExec.body.error.code).toBe('WAIVE_NOT_ALLOWED');
    // Manager can see the executive's customer (read_all) and waive.
    const waived = await book(M, { payment: undefined, waiveReason: 'Cheque tomorrow' });
    expect(waived.status).toBe(201);
    expect(waived.body.data.bookingMoneyWaived.reason).toBe('Cheque tomorrow');
    expect(waived.body.data.receipts).toHaveLength(0);
    expect(await Receipt.countDocuments({ orgId: org._id })).toBe(0);
  });

  it('discount cap per role; admin unlimited', async () => {
    const over = await book(E, { discount: { amount: 1_00_001 * TK, reason: 'Too much' } });
    expect(over.status).toBe(403);
    expect(over.body.error).toMatchObject({ code: 'DISCOUNT_LIMIT', details: { capBps: 100 } });
    const ok1 = await book(E, { discount: { amount: 1_00_000 * TK, reason: 'Max for exec' } });
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.price.contractTotal).toBe(1_02_00_000 * TK);
    const big = await book(A, {
      unitId: units[1].id,
      discount: { amount: 10 * LAKH, reason: 'Director approval' },
    });
    expect(big.status).toBe(201);
  });

  it('held by someone else → 409 for an executive; a manager may book it', async () => {
    expect((await E2.post(`/api/v1/units/${units[0].id}/hold`).send({})).status).toBe(200);
    const res = await book(E);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_HELD_BY_OTHER');
    expect((await book(M)).status).toBe(201);
  });

  it('5 simultaneous bookings of one unit: one wins, numbers stay gapless', async () => {
    const results = await Promise.all(
      [A, M, A, M, A].map((ag, i) =>
        book(ag, { payment: cash(5 * LAKH + i * TK) }, { 'Idempotency-Key': `race-key-${i}-xxxx` }),
      ),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
    expect(await Receipt.countDocuments({ orgId: org._id })).toBe(1);
    const next = await book(A, { unitId: units[1].id });
    expect(next.body.data.bookingNo).toBe('LVR-BK-00002');
    expect(next.body.data.receipts[0].receiptNo).toBe(`LVR-${FY()}-000002`);
  });

  it('Idempotency-Key replays the first booking', async () => {
    const h = { 'Idempotency-Key': 'booking-abc-12345' };
    const first = await book(E, {}, h);
    expect(first.status).toBe(201);
    const again = await book(E, {}, h);
    expect(again.status).toBe(200);
    expect(again.body.meta).toEqual({ replayed: true });
    expect(again.body.data.id).toBe(first.body.data.id);
    const other = await book(E2, {}, h);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('guards: project code, price change, custom schedule, landowner lead, bad bank account', async () => {
    const noCode = await A.patch(`/api/v1/projects/${project.id}`).send({
      version: project.version,
      code: null,
    });
    expect(noCode.status).toBe(200);
    const r1 = await book(E);
    expect(r1.body.error.code).toBe('PROJECT_CODE_REQUIRED');
    expect((await Unit.findOne({ orgId: org._id, _id: units[0].id }).lean()).status).toBe(
      'available',
    );
    await A.patch(`/api/v1/projects/${project.id}`).send({
      version: noCode.body.data.version,
      code: 'LVR',
    });

    const changed = await book(E, { expectedTotal: 1 * LAKH });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('PRICE_CHANGED');

    const custom = [
      { code: 'booking_money', amount: 10 * LAKH },
      { code: 'installment', amount: 93 * LAKH, dueDate: addDays(todayDhaka(), 30) },
    ];
    const ce = await book(E, { planId: undefined, schedule: custom });
    expect(ce.status).toBe(403);
    expect(ce.body.error.code).toBe('CUSTOM_SCHEDULE_NOT_ALLOWED');
    const cm = await book(M, {
      planId: undefined,
      schedule: [custom[0], { ...custom[1], amount: 92 * LAKH }],
      payment: cash(10 * LAKH),
    });
    expect(cm.body.error).toMatchObject({ code: 'SCHEDULE_TOTAL_MISMATCH' });
    const ok = await book(M, { planId: undefined, schedule: custom, payment: cash(10 * LAKH) });
    expect(ok.status).toBe(201);
    expect(ok.body.data.plan).toMatchObject({ custom: true });

    const land = await E.post('/api/v1/leads').send({
      name: 'Land Owner',
      phone: '01912345678',
      type: 'landowner',
    });
    if (land.status === 201) {
      const r = await book(E, { unitId: units[1].id, leadId: land.body.data.id });
      expect(r.body.error.code).toBe('INVALID_LEAD');
    }

    const bt = await book(E, {
      unitId: units[1].id,
      payment: {
        amount: 5 * LAKH,
        mode: 'bank_transfer',
        bankAccountId: project.id,
        reference: 'X1',
      },
    });
    expect(bt.body.error.code).toBe('INVALID_BANK_ACCOUNT');
  });
});

describe('receipts', () => {
  let booking;
  beforeEach(async () => {
    const res = await book(E);
    expect(res.status).toBe(201);
    booking = res.body.data;
  });
  const pay = (agent, body, key) => {
    let req = agent.post(`/api/v1/bookings/${booking.id}/receipts`);
    if (key) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('oldest-first allocation, advance, overpayment, bank transfer', async () => {
    expect((await pay(E, cash(LAKH))).status).toBe(403); // executives don't take later payments
    const bank = await A.post('/api/v1/accounts/bank-accounts').send({
      name: 'DBBL Collection',
      bankName: 'Dutch-Bangla Bank',
      accountNo: '1101234567890',
    });
    expect(bank.status).toBe(201);

    // Down payment is 20 % of ৳1,03,00,000 = ৳20,60,000.
    const r1 = await pay(M, {
      amount: 25 * LAKH,
      mode: 'bank_transfer',
      bankAccountId: bank.body.data.id,
      reference: 'NPSB-778899',
    });
    expect(r1.status).toBe(201);
    expect(r1.body.data.receiptNo).toBe(`LVR-${FY()}-000002`);
    // Installments: (1,03,00,000 − 5,00,000 − 20,60,000 − 10,30,000) / 24 → ৳2,79,583 each.
    const alloc = r1.body.data.allocations;
    expect(alloc.map((a) => a.code)).toEqual(['down_payment', 'installment', 'installment']);
    expect(alloc.map((a) => a.amount)).toEqual([20_60_000 * TK, 2_79_583 * TK, 1_60_417 * TK]);
    expect(r1.body.data.bankAccount).toMatchObject({ name: 'DBBL Collection' });

    const detail = (await M.get(`/api/v1/bookings/${booking.id}`)).body.data;
    expect(detail.totals.paid).toBe(30 * LAKH);
    const over = await pay(M, cash(detail.totals.outstanding + 1));
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({
      code: 'OVERPAYMENT',
      details: { outstanding: detail.totals.outstanding },
    });
    const future = await pay(M, { ...cash(LAKH), date: addDays(todayDhaka(), 1) });
    expect(future.body.error.code).toBe('RECEIPT_DATE_IN_FUTURE');
    const old = await pay(M, { ...cash(LAKH), date: addDays(todayDhaka(), -40) });
    expect(old.body.error.code).toBe('RECEIPT_DATE_TOO_OLD');
    await ledgerOk(M, booking.id);
  });

  it('4 simultaneous receipts: all land, numbers gapless, cache = ledger', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => pay(M, cash(LAKH))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nos = (await Receipt.find({ orgId: org._id }).lean()).map((r) => r.seq).sort();
    expect(nos).toEqual([1, 2, 3, 4, 5]);
    const l = await ledgerOk(M, booking.id);
    expect(l.integrity.paidTotal).toBe(9 * LAKH);
  });

  it('idempotent receipt', async () => {
    const first = await pay(M, cash(LAKH), 'receipt-key-0001');
    const again = await pay(M, cash(LAKH), 'receipt-key-0001');
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await Receipt.countDocuments({ orgId: org._id })).toBe(2);
  });

  it('reversal: admin only, once; number kept; ledger balanced', async () => {
    const r = await pay(M, cash(3 * LAKH));
    const id = r.body.data.id;
    expect(
      (await M.post(`/api/v1/receipts/${id}/reverse`).send({ reason: 'Wrong booking' })).status,
    ).toBe(403);
    const rev = await A.post(`/api/v1/receipts/${id}/reverse`).send({ reason: 'Wrong booking' });
    expect(rev.status).toBe(200);
    expect(rev.body.data).toMatchObject({
      status: 'reversed',
      reversal: { reason: 'Wrong booking' },
    });
    const again = await A.post(`/api/v1/receipts/${id}/reverse`).send({ reason: 'Again' });
    expect(again.status).toBe(409);

    const l = await ledgerOk(A, booking.id);
    expect(l.entries.map((e) => [e.type, e.amount])).toEqual([
      ['receipt', 5 * LAKH],
      ['receipt', 3 * LAKH],
      ['reversal', -3 * LAKH],
    ]);
    expect(l.integrity.paidTotal).toBe(5 * LAKH);
    const next = await pay(M, cash(LAKH));
    expect(next.body.data.receiptNo).toBe(`LVR-${FY()}-000003`); // 000002 stays used (reversed)
    expect(await LedgerEntry.countDocuments({ orgId: org._id })).toBe(4);
  });

  it('receipt register: scoping and filters', async () => {
    await pay(M, cash(LAKH));
    expect((await E.get('/api/v1/receipts')).body.data).toHaveLength(2); // seller sees own booking's
    expect((await E2.get('/api/v1/receipts')).body.data).toHaveLength(0);
    const one = (await M.get('/api/v1/receipts?mode=cash&limit=1')).body;
    expect(one.data).toHaveLength(1);
    expect(one.meta.nextCursor).toBeTruthy();
    const rid = one.data[0].id;
    expect((await E2.get(`/api/v1/receipts/${rid}`)).status).toBe(404);
  });
});

describe('settings, plans, bank accounts', () => {
  it('admin-only settings with version; manager manages plans', async () => {
    const s = (await M.get('/api/v1/accounts/settings')).body.data;
    expect(s).toMatchObject({
      discountLimitBps: { sales_executive: 100, sales_manager: 300 },
      bookingMoneyRequired: true,
      notify: { receiptEmail: true, receiptSms: false },
    });
    expect(
      (
        await M.patch('/api/v1/accounts/settings').send({
          version: s.version,
          bookingMoneyRequired: false,
        })
      ).status,
    ).toBe(403);
    const up = await A.patch('/api/v1/accounts/settings').send({
      version: s.version,
      discountLimitBps: { sales_executive: 200 },
    });
    expect(up.status).toBe(200);
    expect(up.body.data.discountLimitBps).toEqual({ sales_executive: 200, sales_manager: 300 });
    const stale = await A.patch('/api/v1/accounts/settings').send({
      version: s.version,
      bookingMoneyRequired: false,
    });
    expect(stale.status).toBe(409);

    expect(
      (await E.post('/api/v1/payment-plans').send({ name: 'X', spec: PLAN_SPEC })).status,
    ).toBe(403);
    const bad = await M.post('/api/v1/payment-plans').send({
      name: 'Broken',
      spec: { bookingMoney: { type: 'fixed', value: LAKH } },
    });
    expect(bad.status).toBe(422);
    const off = await M.patch(`/api/v1/payment-plans/${plan.id}`).send({
      version: plan.version,
      active: false,
    });
    expect(off.status).toBe(200);
    const r = await book(E);
    expect(r.body.error.code).toBe('INVALID_PLAN');
  });
});
