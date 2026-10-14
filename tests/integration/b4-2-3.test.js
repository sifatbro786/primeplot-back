import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, fiscalYear, todayDhaka } from '#shared/utils/dhakaDate.js';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

/** B4.2 (cheques, stages, schedule changes, transfer, cancel, refunds, reports) + B4.3 documents. */
const TK = 100;
const LAKH = 100_000 * TK;
let app;
let Unit;
let Receipt;
let Notification;
let closePdf;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Unit } = await import('#modules/units/unit.model.js'));
  ({ Receipt } = await import('#modules/accounts/receipt.model.js'));
  ({ Notification } = await import('#modules/notifications/notification.model.js'));
  ({ closePdf } = await import('#modules/documents/pdf.js'));
});
afterAll(async () => {
  await closePdf();
  await stopDb();
});

let org;
let A;
let M;
let E;
let E2;
let manager;
let project;
let units;
let plan;
let customer;
let customer2;
let bank;
const today = () => todayDhaka();
const FY = () => fiscalYear(todayDhaka()).short;

beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  const admin = await createUser(org, { role: 'admin' });
  manager = await createUser(org, { role: 'sales_manager' });
  const exec = await createUser(org, { role: 'sales_executive' });
  const exec2 = await createUser(org, { role: 'sales_executive' });
  A = await loginAgent(request, app, admin);
  M = await loginAgent(request, app, manager);
  E = await loginAgent(request, app, exec);
  E2 = await loginAgent(request, app, exec2);

  const p = await A.post('/api/v1/projects').send({
    name: 'Lake View Residency',
    kind: 'apartment',
    code: 'LVR',
    salesPolicy: { cancellationDeductionBps: 1000, transferFee: 50_000 * TK },
  });
  expect(p.status).toBe(201);
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
  project = priced.body.data;
  units = [];
  for (const pos of ['A', 'B', 'C']) {
    const u = await A.post(`/api/v1/projects/${project.id}/units`).send({
      blockId: b.body.data.id,
      floor: 5,
      position: pos,
      saleableSqft: 1250,
      parkingSlots: 1,
    });
    units.push(u.body.data);
  }
  plan = (
    await M.post('/api/v1/payment-plans').send({
      name: '24 months',
      spec: {
        bookingMoney: { type: 'fixed', value: 5 * LAKH },
        downPayment: { type: 'percent', value: 2000, dueAfterDays: 15 },
        installments: { count: 24, everyMonths: 1 },
        milestones: [{ key: 'roof', label: 'Roof casting', type: 'percent', value: 500 }],
        handover: { type: 'percent', value: 1000 },
      },
    })
  ).body.data;
  customer = (
    await E.post('/api/v1/customers').send({
      name: 'Abdur Rahim',
      nameBn: 'আব্দুর রহিম',
      phone: '01712345678',
      email: 'rahim@example.com',
    })
  ).body.data;
  customer2 = (
    await E.post('/api/v1/customers').send({ name: 'Selina Haque', phone: '01812345678' })
  ).body.data;
  bank = (
    await A.post('/api/v1/accounts/bank-accounts').send({
      name: 'DBBL Collection',
      bankName: 'Dutch-Bangla Bank',
      accountNo: '1101234567890',
    })
  ).body.data;
});

const book = (agent, body = {}) =>
  agent.post('/api/v1/bookings').send({
    unitId: units[0].id,
    customerId: customer.id,
    planId: plan.id,
    payment: { amount: 5 * LAKH, mode: 'cash' },
    ...body,
  });
const detail = async (id) => (await M.get(`/api/v1/bookings/${id}`)).body.data;
const unitStatus = async (u) => (await Unit.findOne({ orgId: org._id, _id: u.id }).lean()).status;
const ledgerOk = async (id) => {
  const l = (await M.get(`/api/v1/bookings/${id}/ledger`)).body.data;
  expect(l.integrity).toMatchObject({ ok: true, mismatchedItems: [] });
  return l;
};
const docsOf = async (id) => (await M.get(`/api/v1/bookings/${id}/documents`)).body.data;

describe('cheques', () => {
  it('booking money by cheque → acknowledged; clear → numbered receipt + allocation', async () => {
    const r = await book(E, {
      payment: {
        mode: 'cheque',
        chequeNo: '0045123',
        bank: 'BRAC Bank',
        chequeDate: today(),
        amount: 5 * LAKH,
      },
    });
    expect(r.status).toBe(201);
    const bk = r.body.data;
    expect(bk.receipts).toHaveLength(0);
    expect(bk.totals.paid).toBe(0);
    expect(bk.cheques[0]).toMatchObject({
      status: 'received',
      chequeNo: '0045123',
      amount: 5 * LAKH,
    });
    expect(await Receipt.countDocuments({ orgId: org._id })).toBe(0);
    expect((await docsOf(bk.id)).map((d) => d.type).sort()).toEqual(['booking_form', 'cheque_ack']);

    const cid = bk.cheques[0].id;
    expect(
      (await E.post(`/api/v1/cheques/${cid}/deposit`).send({ bankAccountId: bank.id })).status,
    ).toBe(403);
    const dep = await M.post(`/api/v1/cheques/${cid}/deposit`).send({ bankAccountId: bank.id });
    expect(dep.status).toBe(200);
    expect(dep.body.data.status).toBe('deposited');
    const clr = await M.post(`/api/v1/cheques/${cid}/clear`).send({});
    expect(clr.status).toBe(200);
    expect(clr.body.data.cheque.status).toBe('cleared');
    expect(clr.body.data.receipt).toMatchObject({
      receiptNo: `LVR-${FY()}-000001`,
      mode: 'cheque',
      instrumentNo: '0045123',
      amount: 5 * LAKH,
      bankAccount: { accountNo: '1101234567890' },
    });
    expect((await detail(bk.id)).schedule[0]).toMatchObject({ paid: 5 * LAKH, status: 'paid' });
    expect((await M.post(`/api/v1/cheques/${cid}/clear`).send({})).body.error.code).toBe(
      'CHEQUE_STATE_CONFLICT',
    );
    await ledgerOk(bk.id);
    expect((await docsOf(bk.id)).map((d) => d.type)).toContain('receipt');
  });

  it('PDC register: duplicate refused, open cheques cap the amount, bounce adds the fee and alerts', async () => {
    const bk = (await book(E)).body.data;
    const s = (await A.get('/api/v1/accounts/settings')).body.data;
    await A.patch('/api/v1/accounts/settings').send({
      version: s.version,
      chequeBounceFee: 500 * TK,
    });

    const pdc = {
      chequeNo: '7788001',
      bank: 'City Bank',
      chequeDate: addDays(today(), 30),
      amount: 2 * LAKH,
    };
    const c1 = await M.post(`/api/v1/bookings/${bk.id}/cheques`).send(pdc);
    expect(c1.status).toBe(201);
    expect(c1.body.data.postDated).toBe(true);
    expect((await M.post(`/api/v1/bookings/${bk.id}/cheques`).send(pdc)).body.error.code).toBe(
      'DUPLICATE_CHEQUE',
    );
    const tooMuch = await M.post(`/api/v1/bookings/${bk.id}/cheques`).send({
      ...pdc,
      chequeNo: '7788002',
      amount: bk.totals.outstanding - 2 * LAKH + 1,
    });
    expect(tooMuch.body.error.code).toBe('OVERPAYMENT');

    const cid = c1.body.data.id;
    expect(
      (await M.post(`/api/v1/cheques/${cid}/bounce`).send({ reason: 'Insufficient funds' })).status,
    ).toBe(409);
    await M.post(`/api/v1/cheques/${cid}/deposit`).send({ bankAccountId: bank.id });
    const bounced = await M.post(`/api/v1/cheques/${cid}/bounce`).send({
      reason: 'Insufficient funds',
    });
    expect(bounced.body.data).toMatchObject({ status: 'bounced', bounceCount: 1 });
    const d = await detail(bk.id);
    const fee = d.schedule.find((i) => i.chargeKind === 'cheque_bounce');
    expect(fee).toMatchObject({ code: 'charge', amount: 500 * TK, dueDate: today() });
    expect(d.contractTotal).toBe(1_03_00_000 * TK);
    expect(
      await Notification.countDocuments({
        orgId: org._id,
        type: 'cheque.bounced',
        userId: manager._id,
      }),
    ).toBe(0); // the manager bounced it themself — only the seller is told
    expect(
      await Notification.countDocuments({ orgId: org._id, type: 'cheque.bounced' }),
    ).toBeGreaterThan(0);

    // re-present, then return
    expect(
      (await M.post(`/api/v1/cheques/${cid}/deposit`).send({ bankAccountId: bank.id })).status,
    ).toBe(200);
    expect(
      (await M.post(`/api/v1/cheques/${cid}/return`).send({ reason: 'Replaced' })).status,
    ).toBe(409);
    const reg = await E.get('/api/v1/cheques?open=true');
    expect(reg.body.data).toHaveLength(1);
    expect((await E2.get('/api/v1/cheques')).body.data).toHaveLength(0);
  });
});

describe('stages', () => {
  it('allot warns on unpaid down payment; register needs allotment; handover; letters issued', async () => {
    const bk = (await book(E)).body.data;
    expect(
      (await M.post(`/api/v1/bookings/${bk.id}/register`).send({ deedNo: 'D-1' })).body.error.code,
    ).toBe('BOOKING_STAGE_CONFLICT');
    expect((await E.post(`/api/v1/bookings/${bk.id}/allot`).send({})).status).toBe(403);
    const al = await M.post(`/api/v1/bookings/${bk.id}/allot`).send({});
    expect(al.status).toBe(200);
    expect(al.body.meta.warnings).toEqual(['DOWN_PAYMENT_UNPAID']);
    expect(al.body.data).toMatchObject({ stage: 'allotted', allotment: { date: today() } });
    expect(await unitStatus(units[0])).toBe('allotted');
    expect((await docsOf(bk.id)).map((d) => d.type)).toContain('allotment_letter');

    const rg = await M.post(`/api/v1/bookings/${bk.id}/register`).send({ deedNo: 'DHK-2026-4412' });
    expect(rg.body.meta.warnings).toEqual(['DUES_OUTSTANDING']);
    expect(rg.body.data.registration).toMatchObject({ deedNo: 'DHK-2026-4412' });
    const ho = await M.post(`/api/v1/bookings/${bk.id}/handover`).send({});
    expect(ho.body.data.stage).toBe('handed_over');
    expect(await unitStatus(units[0])).toBe('handed_over');
    expect(
      (await M.post(`/api/v1/bookings/${bk.id}/cancel`).send({ reason: 'Too late' })).status,
    ).toBe(409);
  });
});

describe('schedule changes', () => {
  it('charges, waiver, calling a milestone, reschedule rules', async () => {
    const bk = (await book(E)).body.data;
    const ch = await M.post(`/api/v1/bookings/${bk.id}/charges`).send({
      kind: 'utility',
      label: 'Gas connection',
      amount: 25_000 * TK,
      dueDate: addDays(today(), 10),
    });
    expect(ch.status).toBe(201);
    const charge = ch.body.data.schedule.find((i) => i.code === 'charge');
    expect(ch.body.data.totals.total).toBe(1_03_25_000 * TK);
    const w = await M.post(`/api/v1/bookings/${bk.id}/charges/${charge.id}/waive`).send({
      reason: 'Goodwill',
    });
    expect(w.body.data.schedule.some((i) => i.code === 'charge')).toBe(false);

    const roof = bk.schedule.find((i) => i.code === 'milestone');
    const called = await M.post(`/api/v1/bookings/${bk.id}/schedule/${roof.id}/call`).send({
      dueDate: addDays(today(), 20),
    });
    expect(called.body.data.schedule.find((i) => i.id === roof.id).dueDate).toBe(
      addDays(today(), 20),
    );

    const cur = await detail(bk.id);
    const items = cur.schedule
      .filter((i) => i.code !== 'charge')
      .map((i) => ({
        id: i.id,
        code: i.code,
        label: i.label,
        dueDate: i.dueDate,
        amount: i.amount,
      }));
    // paid booking money cannot change
    const bad = await M.put(`/api/v1/bookings/${bk.id}/schedule`).send({
      version: cur.version,
      reason: 'test',
      items: [
        { ...items[0], amount: items[0].amount - 100 },
        { ...items[1], amount: items[1].amount + 100 },
        ...items.slice(2),
      ],
    });
    expect(bad.body.error.code).toBe('INVALID_SCHEDULE');
    const mismatch = await M.put(`/api/v1/bookings/${bk.id}/schedule`).send({
      version: cur.version,
      reason: 'test',
      items: items.slice(0, -1),
    });
    expect(mismatch.body.error.code).toBe('SCHEDULE_TOTAL_MISMATCH');
    // merge the last two installments into one
    const inst = items.filter((i) => i.code === 'installment');
    const merged = [
      ...items.filter((i) => i !== inst.at(-1) && i !== inst.at(-2)),
      {
        code: 'installment',
        label: 'Final installment',
        dueDate: inst.at(-1).dueDate,
        amount: inst.at(-1).amount + inst.at(-2).amount,
      },
    ];
    const ok = await M.put(`/api/v1/bookings/${bk.id}/schedule`).send({
      version: cur.version,
      reason: 'Customer asked',
      items: merged,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.schedule.filter((i) => i.code === 'installment')).toHaveLength(
      inst.length - 1,
    );
    expect(ok.body.data.schedule[0]).toMatchObject({ id: items[0].id, paid: 5 * LAKH });
    await ledgerOk(bk.id);
  });
});

describe('transfer', () => {
  it('blocked by overdue dues; then moves the holder, adds the fee, re-issues documents', async () => {
    const old = (await book(E, { bookingDate: addDays(today(), -20) })).body.data; // down payment overdue
    const blocked = await M.post(`/api/v1/bookings/${old.id}/transfer`).send({
      toCustomerId: customer2.id,
    });
    expect(blocked.body.error).toMatchObject({ code: 'OVERDUE_DUES' });

    const bk = (await book(E, { unitId: units[1].id })).body.data;
    const before = await docsOf(bk.id);
    const t = await M.post(`/api/v1/bookings/${bk.id}/transfer`).send({
      toCustomerId: customer2.id,
      note: 'Sold to sister',
    });
    expect(t.status).toBe(200);
    expect(t.body.data.customer).toMatchObject({ id: customer2.id, name: 'Selina Haque' });
    expect(t.body.data.holders[0]).toMatchObject({
      customerId: customer.id,
      toCustomerId: customer2.id,
      fee: 50_000 * TK,
    });
    expect(t.body.data.schedule.find((i) => i.chargeKind === 'transfer_fee').amount).toBe(
      50_000 * TK,
    );
    const after = await docsOf(bk.id);
    const oldForm = after.find((d) => d.id === before.find((x) => x.type === 'booking_form').id);
    expect(oldForm.status).toBe('void');
    expect(after.filter((d) => d.type === 'booking_form' && d.status === 'valid')).toHaveLength(1);
    expect(after.map((d) => d.type)).toContain('transfer_letter');
    // the old receipt keeps the old name
    expect(t.body.data.receipts[0].customerName).toBe('Abdur Rahim');
  });
});

describe('cancellation & refunds', () => {
  it('policy deduction, override rules, unit back on sale, refunds up to the due amount', async () => {
    const bk = (await book(E, { payment: { amount: 10 * LAKH, mode: 'cash' } })).body.data;
    expect(
      (await E.post(`/api/v1/bookings/${bk.id}/cancel`).send({ reason: 'Buyer moving' })).status,
    ).toBe(403);
    const pre = await M.post(`/api/v1/bookings/${bk.id}/cancel/preview`).send({});
    expect(pre.body.data).toMatchObject({
      paid: 10 * LAKH,
      deductionBps: 1000,
      deduction: LAKH,
      refundable: 9 * LAKH,
    });

    const noReason = await M.post(`/api/v1/bookings/${bk.id}/cancel`).send({
      reason: 'Buyer moving',
      deductionAmount: 2 * LAKH,
    });
    expect(noReason.body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const c = await M.post(`/api/v1/bookings/${bk.id}/cancel`).send({
      reason: 'Buyer moving abroad',
      deductionAmount: 2 * LAKH,
      overrideReason: 'Agreed with MD',
    });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({
      status: 'cancelled',
      cancellation: {
        deduction: 2 * LAKH,
        refundable: 8 * LAKH,
        refundDue: 8 * LAKH,
        overrideReason: 'Agreed with MD',
      },
    });
    expect(await unitStatus(units[0])).toBe('available');
    const types = (await docsOf(bk.id)).map((d) => `${d.type}:${d.status}`);
    expect(types).toContain('cancellation_letter:valid');
    expect(types).toContain('booking_form:void');

    const r1 = await M.post(`/api/v1/bookings/${bk.id}/refunds`).send({
      amount: 5 * LAKH,
      mode: 'cash',
    });
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({ refund: { ref: 'LVR-RF-00001' }, refundDue: 3 * LAKH });
    const r2 = await M.post(`/api/v1/bookings/${bk.id}/refunds`).send({
      amount: 3 * LAKH + 1,
      mode: 'cash',
    });
    expect(r2.body.error).toMatchObject({
      code: 'REFUND_EXCEEDS_DUE',
      details: { refundDue: 3 * LAKH },
    });
    const l = await ledgerOk(bk.id);
    expect(l.refunded).toBe(5 * LAKH);
    expect(
      (await M.post(`/api/v1/bookings/${bk.id}/receipts`).send({ amount: LAKH, mode: 'cash' })).body
        .error.code,
    ).toBe('BOOKING_NOT_ACTIVE');
    // the unit can be sold again
    expect((await book(M)).status).toBe(201);
  });

  it('open cheques block a cancellation', async () => {
    const bk = (await book(E)).body.data;
    await M.post(`/api/v1/bookings/${bk.id}/cheques`).send({
      chequeNo: '5550001',
      bank: 'EBL',
      chequeDate: addDays(today(), 5),
      amount: LAKH,
    });
    expect(
      (await M.post(`/api/v1/bookings/${bk.id}/cancel`).send({ reason: 'Changed mind' })).body.error
        .code,
    ).toBe('OPEN_CHEQUES');
  });
});

describe('reports', () => {
  it('dues with aging, collections by mode, PDC register; managers only', async () => {
    const late = (await book(E, { bookingDate: addDays(today(), -20) })).body.data;
    await book(E, { unitId: units[1].id, payment: { amount: 6 * LAKH, mode: 'cash' } });
    await M.post(`/api/v1/bookings/${late.id}/cheques`).send({
      chequeNo: '9990001',
      bank: 'UCB',
      chequeDate: addDays(today(), 7),
      amount: LAKH,
    });
    expect((await E.get('/api/v1/reports/dues')).status).toBe(403);
    const dues = (await M.get('/api/v1/reports/dues')).body.data;
    expect(dues.items).toHaveLength(1);
    expect(dues.items[0]).toMatchObject({
      bookingNo: late.bookingNo,
      customer: { phone: '+8801712345678' },
    });
    expect(dues.items[0].buckets.d1_30).toBe(dues.items[0].overdue);
    const all = (await M.get('/api/v1/reports/dues?overdueOnly=false')).body.data;
    expect(all.items).toHaveLength(2);

    const from = addDays(today(), -30);
    const col = (await M.get(`/api/v1/reports/collections?from=${from}&to=${today()}`)).body.data;
    expect(col.total).toEqual({ count: 2, amount: 11 * LAKH });
    expect(col.byMode).toEqual([{ mode: 'cash', count: 2, amount: 11 * LAKH }]);
    expect(col.byProject[0].project.code).toBe('LVR');

    const pdc = (await M.get('/api/v1/reports/pdcs')).body.data;
    expect(pdc.totals.upcoming).toEqual({ count: 1, amount: LAKH });
  });
});

describe('documents', () => {
  it('HTML page, PDF, public verification, void on reversal, statements', async () => {
    const bk = (await book(E)).body.data;
    const list = await docsOf(bk.id);
    const receiptDoc = list.find((d) => d.type === 'receipt');
    expect(receiptDoc).toMatchObject({
      number: `LVR-${FY()}-000001`,
      status: 'valid',
      locale: 'bn',
    });

    const html = await M.get(`/api/v1/documents/${receiptDoc.id}/html?locale=en`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain(receiptDoc.number);
    expect(html.text).toContain('Five Lakh Taka Only');
    expect((await E2.get(`/api/v1/documents/${receiptDoc.id}/html`)).status).toBe(404);

    const pdf = await M.get(`/api/v1/documents/${receiptDoc.id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    const token = receiptDoc.verifyUrl.split('/').pop();
    const pub = await request(app).get(`/api/v1/public/verify/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({
      valid: true,
      type: 'receipt',
      holder: 'A**** R****',
      amount: 5 * LAKH,
    });
    expect(JSON.stringify(pub.body.data)).not.toContain('01712345678');
    expect((await request(app).get('/api/v1/public/verify/not-a-real-token-123456')).status).toBe(
      404,
    );

    const receiptId = bk.receipts[0].id;
    await A.post(`/api/v1/receipts/${receiptId}/reverse`).send({ reason: 'Entered twice' });
    const after = (await request(app).get(`/api/v1/public/verify/${token}`)).body.data;
    expect(after).toMatchObject({
      valid: false,
      status: 'void',
      voidReason: 'Reversed: Entered twice',
    });

    expect((await E.post(`/api/v1/bookings/${bk.id}/statement`)).status).toBe(403);
    const st = await M.post(`/api/v1/bookings/${bk.id}/statement`);
    expect(st.status).toBe(201);
    expect(st.body.data).toMatchObject({ type: 'statement', status: 'valid' });
  });
});
