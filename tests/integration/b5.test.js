import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayDhaka } from '#shared/utils/dhakaDate.js';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent, ORIGIN, PASSWORD } from '../helpers/factory.js';

/** B5 — customer portal, slips, profile requests, SSLCommerz, reminders, analytics. */
vi.hoisted(() => {
  process.env.SSLCZ_STORE_ID = 'teststore';
  process.env.SSLCZ_STORE_PASS = 'teststore@ssl';
  process.env.API_PUBLIC_URL = 'https://api.example.test';
});

const TK = 100;
const LAKH = 100_000 * TK;
let app;
let User;
let Customer;
let Job;
let SmsMessage;
let Receipt;
let OnlinePayment;
let Notification;
let ReminderLog;
let runReminders;
let reconcilePayments;
let realFetch;

beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ User } = await import('#modules/users/user.model.js'));
  ({ Customer } = await import('#modules/customers/customer.model.js'));
  ({ Job } = await import('#jobs/job.model.js'));
  ({ SmsMessage } = await import('#modules/sms/smsMessage.model.js'));
  ({ Receipt } = await import('#modules/accounts/receipt.model.js'));
  ({ OnlinePayment } = await import('#modules/payments/onlinePayment.model.js'));
  ({ Notification } = await import('#modules/notifications/notification.model.js'));
  ({ ReminderLog } = await import('#modules/reminders/reminderLog.model.js'));
  ({ runReminders } = await import('#modules/reminders/reminder.service.js'));
  ({ reconcilePayments } = await import('#modules/payments/payment.service.js'));
  realFetch = globalThis.fetch;
});
afterAll(stopDb);
afterEach(() => {
  globalThis.fetch = realFetch;
});

let org;
let A;
let M;
let E;
let project;
let units;
let plan;
let rahim; // holder, has e-mail
let selina; // co-applicant, phone only
let karim; // another buyer
let bank;
let booking;

const NEW_PASSWORD = 'portal-secret-passphrase';

beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  const admin = await createUser(org, { role: 'admin' });
  const manager = await createUser(org, { role: 'sales_manager' });
  const exec = await createUser(org, { role: 'sales_executive' });
  A = await loginAgent(request, app, admin);
  M = await loginAgent(request, app, manager);
  E = await loginAgent(request, app, exec);

  const p = await A.post('/api/v1/projects').send({
    name: 'Lake View Residency',
    kind: 'apartment',
    code: 'LVR',
  });
  const b = await A.post(`/api/v1/projects/${p.body.data.id}/blocks`).send({
    kind: 'building',
    code: 'A',
    name: 'Tower A',
    lowestFloor: 0,
    highestFloor: 10,
  });
  project = (
    await A.put(`/api/v1/projects/${p.body.data.id}/pricing`).send({
      version: p.body.data.version,
      pricing: { ratePerSqft: 8_000 * TK },
    })
  ).body.data;
  units = [];
  for (const pos of ['A', 'B']) {
    units.push(
      (
        await A.post(`/api/v1/projects/${project.id}/units`).send({
          blockId: b.body.data.id,
          floor: 5,
          position: pos,
          saleableSqft: 1000,
        })
      ).body.data,
    );
  }
  plan = (
    await M.post('/api/v1/payment-plans').send({
      name: '12 months',
      spec: {
        bookingMoney: { type: 'fixed', value: 5 * LAKH },
        downPayment: { type: 'percent', value: 2000, dueAfterDays: 15 },
        installments: { count: 12, everyMonths: 1 },
      },
    })
  ).body.data;
  rahim = (
    await E.post('/api/v1/customers').send({
      name: 'Abdur Rahim',
      phone: '01712345678',
      email: 'rahim@example.com',
    })
  ).body.data;
  selina = (await E.post('/api/v1/customers').send({ name: 'Selina Haque', phone: '01812345678' }))
    .body.data;
  karim = (await E.post('/api/v1/customers').send({ name: 'Karim Uddin', phone: '01912345678' }))
    .body.data;
  bank = (
    await A.post('/api/v1/accounts/bank-accounts').send({
      name: 'DBBL',
      bankName: 'Dutch-Bangla Bank',
      accountNo: '1101234567890',
    })
  ).body.data;
  const r = await E.post('/api/v1/bookings').send({
    unitId: units[0].id,
    customerId: rahim.id,
    coApplicantIds: [selina.id],
    planId: plan.id,
    payment: { amount: 5 * LAKH, mode: 'cash' },
  });
  expect(r.status).toBe(201);
  booking = r.body.data;
});

// ── helpers ─────────────────────────────────────────────────────────────────────

const setupTokenFromEmail = async (to) => {
  const job = await Job.findOne({
    orgId: org._id,
    type: 'email.send',
    'payload.template': 'account_setup',
    'payload.to': to,
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  return job ? new URL(job.payload.data.url).searchParams.get('token') : null;
};
const tokenFromSms = async (to, purpose = 'account_setup') => {
  const sms = await SmsMessage.findOne({ orgId: org._id, to, purpose })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const m = /token=([\w-]{43})/.exec(sms?.body ?? '');
  return m ? m[1] : null;
};
const clientAgent = async (identifier, password = NEW_PASSWORD) => {
  const agent = request.agent(app).set('Origin', ORIGIN);
  const res = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ identifier, password });
  if (res.status !== 200)
    throw new Error(`client login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
};
const activate = async (token) => {
  const res = await request(app)
    .post('/api/v1/auth/setup-account')
    .set('Origin', ORIGIN)
    .send({ token, password: NEW_PASSWORD });
  expect(res.status).toBe(204);
};
const rahimClient = async () => {
  await activate(await setupTokenFromEmail('rahim@example.com'));
  return clientAgent('01712-345678');
};
const pngOf = (color) =>
  sharp({ create: { width: 40, height: 40, channels: 3, background: color } })
    .png()
    .toBuffer();
const uploadSlip = async (agent, color = '#2d3228') =>
  (
    await agent
      .post('/api/v1/media')
      .field('purpose', 'payment_slip')
      .attach('file', await pngOf(color), 'slip.png')
  ).body.data;
const paidOf = async (id) => (await M.get(`/api/v1/bookings/${id}`)).body.data.totals.paid;

// ── Portal accounts ─────────────────────────────────────────────────────────────

describe('client logins', () => {
  it('booking → holder login (invited) + setup link by e-mail and SMS; phone and e-mail both sign in', async () => {
    const c = await Customer.findOne({ orgId: org._id, _id: rahim.id }).lean();
    expect(c.portalUserId).toBeTruthy();
    const u = await User.findOne({ orgId: org._id, _id: c.portalUserId }).lean();
    expect(u).toMatchObject({
      role: 'client',
      status: 'invited',
      phone: '+8801712345678',
      email: 'rahim@example.com',
    });
    expect(String(u.customerId)).toBe(rahim.id);
    expect(await tokenFromSms('+8801712345678')).toBeTruthy(); // SMS queued with the link

    // The SMS log never shows the link.
    const log = (await A.get('/api/v1/integrations/sms/messages?purpose=account_setup')).body.data;
    expect(log[0].body).toContain('[link]');
    expect(log[0].body).not.toContain('token=');

    // Co-applicant: not invited automatically (setting off by default).
    expect(
      (await Customer.findOne({ orgId: org._id, _id: selina.id }).lean()).portalUserId,
    ).toBeNull();

    const token = await setupTokenFromEmail('rahim@example.com');
    const inspect = await request(app)
      .post('/api/v1/auth/token/inspect')
      .set('Origin', ORIGIN)
      .send({ token, purpose: 'account_setup' });
    expect(inspect.body.data).toMatchObject({
      valid: true,
      role: 'client',
      phone: '+880 17••••5678',
    });
    await activate(token);

    const byPhone = await clientAgent('01712345678');
    const me = await byPhone.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('client');
    expect(me.body.data.user.permissions).toContain('portal:access');
    expect((await clientAgent('rahim@example.com')).get).toBeTypeOf('function');
    // Staff endpoints stay closed.
    expect((await byPhone.get('/api/v1/bookings')).status).toBe(403);
    expect((await byPhone.get('/api/v1/customers')).status).toBe(403);
    // Wrong password by phone → the generic error.
    const bad = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ identifier: '01712345678', password: 'nope-nope-nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    // Clients are not in the staff user list.
    expect((await A.get('/api/v1/users')).body.data.every((x) => x.role !== 'client')).toBe(true);
  });

  it('staff invite a phone-only co-applicant; SMS link; they see the booking as co-applicant', async () => {
    const st = await E.get(`/api/v1/customers/${selina.id}/portal`);
    expect(st.body.data.status).toBe('none');
    const inv = await E.post(`/api/v1/customers/${selina.id}/portal/invite`).send({});
    expect(inv.status).toBe(200);
    expect(inv.body.data).toMatchObject({
      status: 'invited',
      created: true,
      sent: { sms: true, email: false },
    });
    expect(inv.body.data.portal.login.email).toBeNull();
    const again = await E.post(`/api/v1/customers/${selina.id}/portal/invite`).send({});
    expect(again.body.data.reason).toBe('recently_sent');
    expect(
      (await E.post(`/api/v1/customers/${selina.id}/portal/invite`).send({ force: true })).body.data
        .sent.sms,
    ).toBe(true);

    await activate(await tokenFromSms('+8801812345678'));
    const s = await clientAgent('+8801812345678');
    const list = (await s.get('/api/v1/portal/bookings')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: booking.id,
      role: 'co_applicant',
      holderName: 'Abdur Rahim',
    });
    // Someone with no booking can't be invited.
    expect(
      (await E.post(`/api/v1/customers/${karim.id}/portal/invite`).send({})).body.error.code,
    ).toBe('NOT_ON_A_BOOKING');
  });

  it("a client never sees another buyer's booking or documents", async () => {
    const other = await E.post('/api/v1/bookings').send({
      unitId: units[1].id,
      customerId: karim.id,
      planId: plan.id,
      payment: { amount: 5 * LAKH, mode: 'cash' },
    });
    const c = await rahimClient();
    expect((await c.get(`/api/v1/portal/bookings/${other.body.data.id}`)).status).toBe(404);
    const docs = (await M.get(`/api/v1/bookings/${other.body.data.id}/documents`)).body.data;
    expect((await c.get(`/api/v1/portal/documents/${docs[0].id}/html`)).status).toBe(404);
    // Own booking: detail, schedule, receipts, documents, HTML.
    const mine = (await c.get(`/api/v1/portal/bookings/${booking.id}`)).body.data;
    expect(mine.role).toBe('holder');
    expect(mine.receipts).toHaveLength(1);
    expect(mine.schedule.length).toBeGreaterThan(10);
    expect(mine.documents.map((d) => d.type).sort()).toEqual(['booking_form', 'receipt']);
    const html = await c.get(`/api/v1/portal/documents/${mine.documents[0].id}/html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    const dues = (await c.get('/api/v1/portal/dues?days=365')).body.data;
    expect(dues.items.length).toBeGreaterThan(5);
    const me = (await c.get('/api/v1/portal/me')).body.data;
    expect(me.profile).toMatchObject({ customerNo: rahim.customerNo, phone: '+8801712345678' });
    expect(me.features).toMatchObject({ onlinePayment: true, slipUpload: true });
    expect(me.bankAccounts.map((x) => x.id)).toEqual([bank.id]);
  });

  it('switching a login off ends its session; on again restores it', async () => {
    const c = await rahimClient();
    expect((await c.get('/api/v1/portal/me')).status).toBe(200);
    expect(
      (await E.patch(`/api/v1/customers/${rahim.id}/portal`).send({ enabled: false })).status,
    ).toBe(403);
    const off = await M.patch(`/api/v1/customers/${rahim.id}/portal`).send({ enabled: false });
    expect(off.body.data.status).toBe('disabled');
    expect((await c.get('/api/v1/portal/me')).status).toBe(401);
    const on = await M.patch(`/api/v1/customers/${rahim.id}/portal`).send({ enabled: true });
    expect(on.body.data.status).toBe('active');
    expect((await (await clientAgent('01712345678')).get('/api/v1/portal/me')).status).toBe(200);
  });

  it('forgot password with the phone sends an SMS reset link; staff edits follow to the login', async () => {
    await rahimClient();
    const f = await request(app)
      .post('/api/v1/auth/password/forgot')
      .set('Origin', ORIGIN)
      .send({ identifier: '01712345678' });
    expect(f.status).toBe(202);
    expect(await tokenFromSms('+8801712345678', 'password_reset')).toBeTruthy();

    const cust = (await E.get(`/api/v1/customers/${rahim.id}`)).body.data;
    await E.patch(`/api/v1/customers/${rahim.id}`).send({
      version: cust.version,
      phone: '01711111111',
    });
    expect((await clientAgent('01711111111')).get).toBeTypeOf('function');
  });

  it('a transfer gives the new holder a login and the old one loses the booking', async () => {
    const c = await rahimClient();
    const t = await M.post(`/api/v1/bookings/${booking.id}/transfer`).send({
      toCustomerId: karim.id,
      waiveFeeReason: 'Family transfer',
    });
    expect(t.status).toBe(200);
    expect((await c.get(`/api/v1/portal/bookings/${booking.id}`)).status).toBe(404);
    expect(
      (await Customer.findOne({ orgId: org._id, _id: karim.id }).lean()).portalUserId,
    ).toBeTruthy();
  });
});

// ── Slips ───────────────────────────────────────────────────────────────────────

describe('bank slips', () => {
  it('submit → verifier approves (corrected amount) → receipt `slip`; double approve refused', async () => {
    const c = await rahimClient();
    const media = await uploadSlip(c);
    expect(media.visibility).toBe('private');
    const body = {
      amount: 2 * LAKH,
      paidOn: todayDhaka(),
      channel: 'bank_transfer',
      bankAccountId: bank.id,
      reference: 'FT2610150001',
      mediaId: media.id,
    };
    const s = await c.post(`/api/v1/portal/bookings/${booking.id}/slips`).send(body);
    expect(s.status).toBe(201);
    expect(s.body.data.status).toBe('pending');
    expect(
      (await c.post(`/api/v1/portal/bookings/${booking.id}/slips`).send(body)).body.error.code,
    ).toBe('SLIP_FILE_REUSED');
    expect(
      await Notification.countDocuments({ orgId: org._id, type: 'payment_slip.submitted' }),
    ).toBeGreaterThan(0);

    // The seller sees it, but can't verify.
    expect((await E.get(`/api/v1/payment-slips/${s.body.data.id}`)).status).toBe(200);
    expect((await E.post(`/api/v1/payment-slips/${s.body.data.id}/approve`).send({})).status).toBe(
      403,
    );

    const detail = (await M.get(`/api/v1/payment-slips/${s.body.data.id}`)).body.data;
    expect(detail.file.urls.full).toContain(`/api/v1/media/${media.id}/file`);
    expect((await M.get(`/api/v1/media/${media.id}/file`)).status).toBe(200);

    const before = await paidOf(booking.id);
    const ok = await M.post(`/api/v1/payment-slips/${s.body.data.id}/approve`).send({
      amount: 1.5 * LAKH,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('approved');
    expect(ok.body.data.receipt.receiptNo).toMatch(/^LVR-\d{4}-\d{6}$/);
    expect(await paidOf(booking.id)).toBe(before + 1.5 * LAKH);
    const r = await Receipt.findOne({ orgId: org._id, _id: ok.body.data.receipt.id }).lean();
    expect(r).toMatchObject({ mode: 'slip', amount: 1.5 * LAKH, reference: 'FT2610150001' });
    expect(
      (await M.post(`/api/v1/payment-slips/${s.body.data.id}/approve`).send({})).body.error.code,
    ).toBe('SLIP_NOT_PENDING');
    // Ledger stays consistent.
    expect((await M.get(`/api/v1/bookings/${booking.id}/ledger`)).body.data.integrity.ok).toBe(
      true,
    );
  });

  it('reject tells the client why; withdraw; over the balance is refused', async () => {
    const c = await rahimClient();
    const m1 = await uploadSlip(c, '#6b705c');
    const s1 = (
      await c
        .post(`/api/v1/portal/bookings/${booking.id}/slips`)
        .send({
          amount: LAKH,
          paidOn: todayDhaka(),
          channel: 'cash_deposit',
          bankAccountId: bank.id,
          mediaId: m1.id,
        })
    ).body.data;
    const rej = await M.post(`/api/v1/payment-slips/${s1.id}/reject`).send({
      reason: 'Amount not in our statement',
    });
    expect(rej.body.data.status).toBe('rejected');
    const mine = (await c.get('/api/v1/portal/slips')).body.data;
    expect(mine[0]).toMatchObject({
      status: 'rejected',
      rejectReason: 'Amount not in our statement',
    });
    expect(await SmsMessage.countDocuments({ orgId: org._id, purpose: 'portal' })).toBe(1);

    const m2 = await uploadSlip(c, '#e5e3df');
    const s2 = (
      await c
        .post(`/api/v1/portal/bookings/${booking.id}/slips`)
        .send({ amount: LAKH, paidOn: todayDhaka(), channel: 'pay_order', mediaId: m2.id })
    ).body.data;
    expect((await c.post(`/api/v1/portal/slips/${s2.id}/withdraw`)).body.data.status).toBe(
      'withdrawn',
    );

    const m3 = await uploadSlip(c, '#1c1d1a');
    const big = await c
      .post(`/api/v1/portal/bookings/${booking.id}/slips`)
      .send({ amount: 500 * LAKH, paidOn: todayDhaka(), channel: 'pay_order', mediaId: m3.id });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('OVERPAYMENT');
    // Someone else's upload can't be attached.
    const other = await uploadSlip(M, '#abcdef');
    expect(
      (
        await c
          .post(`/api/v1/portal/bookings/${booking.id}/slips`)
          .send({ amount: LAKH, paidOn: todayDhaka(), channel: 'pay_order', mediaId: other.id })
      ).status,
    ).toBe(422);
  });
});

// ── Profile change requests ─────────────────────────────────────────────────────

describe('profile change requests', () => {
  it('one pending at a time; approve applies to the customer and the login', async () => {
    const c = await rahimClient();
    const r = await c
      .post('/api/v1/portal/profile-requests')
      .send({ presentAddress: 'House 9, Road 2, Dhanmondi', phone: '01799999999' });
    expect(r.status).toBe(201);
    expect(r.body.data.changes).toEqual({
      presentAddress: 'House 9, Road 2, Dhanmondi',
      phone: '+8801799999999',
    });
    expect(
      (await c.post('/api/v1/portal/profile-requests').send({ occupation: 'Doctor' })).body.error
        .code,
    ).toBe('PROFILE_REQUEST_PENDING');
    expect((await c.post('/api/v1/portal/profile-requests').send({ name: 'Other' })).status).toBe(
      422,
    );

    expect((await E.get('/api/v1/profile-requests')).status).toBe(403);
    const ok = await M.post(`/api/v1/profile-requests/${r.body.data.id}/approve`);
    expect(ok.body.data.status).toBe('approved');
    const cust = await Customer.findOne({ orgId: org._id, _id: rahim.id }).lean();
    expect(cust).toMatchObject({
      phone: '+8801799999999',
      presentAddress: 'House 9, Road 2, Dhanmondi',
    });
    expect((await clientAgent('01799999999')).get).toBeTypeOf('function');

    const r2 = (
      await (
        await clientAgent('01799999999')
      )
        .post('/api/v1/portal/profile-requests')
        .send({ occupation: 'Doctor' })
    ).body.data;
    const no = await M.post(`/api/v1/profile-requests/${r2.id}/reject`).send({
      reason: 'Bring your papers',
    });
    expect(no.body.data).toMatchObject({ status: 'rejected', rejectReason: 'Bring your papers' });
  });

  it('a client cannot change name/phone through /auth/me; the language follows the portal setting', async () => {
    const c = await rahimClient();
    const locked = await c.patch('/api/v1/auth/me').send({ phone: '01799999999' });
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('CLIENT_PROFILE_LOCKED');
    expect((await c.patch('/api/v1/auth/me').send({ name: 'Someone Else' })).status).toBe(403);
    expect((await c.patch('/api/v1/portal/me').send({ locale: 'en' })).status).toBe(204);
    expect((await c.get('/api/v1/auth/me')).body.data.user.locale).toBe('en');
    expect((await Customer.findOne({ orgId: org._id, _id: rahim.id }).lean()).locale).toBe('en');
  });
});

// ── SSLCommerz ──────────────────────────────────────────────────────────────────

/** A fake SSLCommerz: sessions open; validation / query answers come from these maps. */
function fakeGateway({ validations = {}, queries = {} } = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    const json = (b) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (u.pathname.endsWith('/gwprocess/v4/api.php')) {
      const form = new URLSearchParams(init.body);
      expect(form.get('ipn_url')).toBe('https://api.example.test/api/v1/webhooks/sslcommerz/ipn');
      return json({
        status: 'SUCCESS',
        sessionkey: `S-${form.get('tran_id')}`,
        GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/${form.get('tran_id')}`,
      });
    }
    if (u.pathname.endsWith('/validationserverAPI.php')) {
      return json(validations[u.searchParams.get('val_id')] ?? { status: 'INVALID_TRANSACTION' });
    }
    if (u.pathname.endsWith('/merchantTransIDvalidationAPI.php')) {
      return json({ APIConnect: 'DONE', element: queries[u.searchParams.get('tran_id')] ?? [] });
    }
    return realFetch(url, init);
  });
  return calls;
}
const valid = (p, extra = {}) => ({
  status: 'VALID',
  tran_id: p.tranId,
  val_id: extra.val_id ?? 'V1',
  amount: (p.amount / 100).toFixed(2),
  currency: 'BDT',
  currency_type: 'BDT',
  currency_amount: (p.amount / 100).toFixed(2),
  risk_level: '0',
  bank_tran_id: 'BTX1',
  card_type: 'BKASH-BKash',
  tran_date: `${todayDhaka()} 10:00:00`,
  ...extra,
});
const hook = (kind, body) =>
  request(app).post(`/api/v1/webhooks/sslcommerz/${kind}`).type('form').send(body);

describe('SSLCommerz', () => {
  const start = async (c, amount = 2 * LAKH, key) => {
    const req = c.post(`/api/v1/portal/bookings/${booking.id}/pay`);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ amount });
  };

  it('pay → success redirect → validated → ONE receipt, even when the IPN races in', async () => {
    const validations = {};
    fakeGateway({ validations });
    const c = await rahimClient();
    const res = await start(c, 2 * LAKH, 'pay-key-0001');
    expect(res.status).toBe(201);
    expect(res.body.data.redirectUrl).toMatch(/^https:\/\/sandbox\.sslcommerz\.com\//);
    expect((await start(c, 2 * LAKH, 'pay-key-0001')).body.meta.replayed).toBe(true);
    const p = await OnlinePayment.findOne({ orgId: org._id, _id: res.body.data.payment.id }).lean();
    validations.V1 = valid(p);

    const before = await paidOf(booking.id);
    const [back, ipn] = await Promise.all([
      hook('success', { tran_id: p.tranId, val_id: 'V1', status: 'VALID', amount: '2000.00' }),
      hook('ipn', { tran_id: p.tranId, val_id: 'V1', status: 'VALID', amount: '2000.00' }),
    ]);
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(
      `http://localhost:3000/bn/portal/payments/${p._id}?result=success`,
    );
    expect(ipn.status).toBe(200);
    expect(await Receipt.countDocuments({ orgId: org._id, mode: 'online' })).toBe(1);
    expect(await paidOf(booking.id)).toBe(before + 2 * LAKH);
    // A late IPN changes nothing.
    await hook('ipn', { tran_id: p.tranId, val_id: 'V1', status: 'VALIDATED' });
    expect(await Receipt.countDocuments({ orgId: org._id, mode: 'online' })).toBe(1);

    const mine = (await c.get(`/api/v1/portal/payments/${p._id}`)).body.data;
    expect(mine.status).toBe('paid');
    expect(mine.receipt.receiptNo).toMatch(/^LVR-/);
    const r = await Receipt.findOne({ orgId: org._id, mode: 'online' }).lean();
    expect(r).toMatchObject({
      reference: 'BTX1',
      receivedByName: 'SSLCommerz',
      idempotencyKey: `sslcz:${p.tranId}`,
    });
    expect((await M.get(`/api/v1/bookings/${booking.id}/ledger`)).body.data.integrity.ok).toBe(
      true,
    );
  });

  it('high risk and amount mismatch are held for review; staff decide', async () => {
    const validations = {};
    fakeGateway({ validations });
    const c = await rahimClient();
    const p1 = await OnlinePayment.findOne({
      orgId: org._id,
      _id: (await start(c, LAKH)).body.data.payment.id,
    }).lean();
    validations.R1 = valid(p1, { val_id: 'R1', risk_level: '1', risk_title: 'Risky' });
    await hook('ipn', { tran_id: p1.tranId, val_id: 'R1', status: 'VALID' });
    expect((await OnlinePayment.findOne({ orgId: org._id, _id: p1._id }).lean()).status).toBe(
      'review',
    );
    expect(await Receipt.countDocuments({ orgId: org._id, mode: 'online' })).toBe(0);
    expect((await c.get(`/api/v1/portal/payments/${p1._id}`)).body.data.status).toBe('review');
    expect(
      await Notification.countDocuments({ orgId: org._id, type: 'online_payment.review' }),
    ).toBeGreaterThan(0);
    expect((await E.post(`/api/v1/online-payments/${p1._id}/approve`).send({})).status).toBe(403);
    const ap = await M.post(`/api/v1/online-payments/${p1._id}/approve`).send({
      note: 'Called the buyer, card is his',
    });
    expect(ap.body.data.status).toBe('paid');
    expect(await Receipt.countDocuments({ orgId: org._id, mode: 'online' })).toBe(1);

    const p2 = await OnlinePayment.findOne({
      orgId: org._id,
      _id: (await start(c, LAKH)).body.data.payment.id,
    }).lean();
    validations.X1 = valid(p2, { val_id: 'X1', currency_amount: '10.00', amount: '10.00' });
    await hook('success', { tran_id: p2.tranId, val_id: 'X1', status: 'VALID' });
    const held = (await M.get(`/api/v1/online-payments/${p2._id}`)).body.data;
    expect(held).toMatchObject({ status: 'review', reviewReason: 'AMOUNT_MISMATCH' });
    expect(
      (await M.post(`/api/v1/online-payments/${p2._id}/approve`).send({})).body.error.code,
    ).toBe('AMOUNT_MISMATCH');
    expect(
      (
        await M.post(`/api/v1/online-payments/${p2._id}/reject`).send({
          reason: 'Refund from panel',
        })
      ).body.data.status,
    ).toBe('rejected');
  });

  it('fail/cancel close the attempt; the reconcile job still finds a VALID payment', async () => {
    const validations = {};
    const queries = {};
    fakeGateway({ validations, queries });
    const c = await rahimClient();
    const p = await OnlinePayment.findOne({
      orgId: org._id,
      _id: (await start(c, LAKH)).body.data.payment.id,
    }).lean();
    const fail = await hook('fail', { tran_id: p.tranId, status: 'FAILED' });
    expect(fail.headers.location).toContain('result=fail');
    expect((await OnlinePayment.findOne({ orgId: org._id, _id: p._id }).lean()).status).toBe(
      'failed',
    );

    queries[p.tranId] = [{ status: 'VALID', val_id: 'Q1', tran_id: p.tranId, amount: '1000.00' }];
    validations.Q1 = valid(p, { val_id: 'Q1' });
    await OnlinePayment.collection.updateOne(
      { _id: p._id },
      { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } },
    );
    const out = await reconcilePayments(org._id);
    expect(out).toMatchObject({ checked: 1, paid: 1 });
    expect((await OnlinePayment.findOne({ orgId: org._id, _id: p._id }).lean()).status).toBe(
      'paid',
    );

    // Never came back at all → expired after 3 h.
    const p2 = await OnlinePayment.findOne({
      orgId: org._id,
      _id: (await start(c, LAKH)).body.data.payment.id,
    }).lean();
    await OnlinePayment.collection.updateOne(
      { _id: p2._id },
      { $set: { createdAt: new Date(Date.now() - 4 * 3_600_000) } },
    );
    await reconcilePayments(org._id);
    expect((await OnlinePayment.findOne({ orgId: org._id, _id: p2._id }).lean()).status).toBe(
      'expired',
    );
  });

  it('limits: minimum, balance, unknown tran_id, forged success without validation', async () => {
    fakeGateway();
    const c = await rahimClient();
    expect((await start(c, 50 * TK)).body.error.code).toBe('AMOUNT_TOO_SMALL');
    expect((await start(c, 900 * LAKH)).body.error.code).toBe('OVERPAYMENT');
    const unknown = await hook('success', { tran_id: 'PP0123456789ABCDEF01234567', val_id: 'Z' });
    expect(unknown.headers.location).toBe('http://localhost:3000/bn/portal');
    const p = await OnlinePayment.findOne({
      orgId: org._id,
      _id: (await start(c, LAKH)).body.data.payment.id,
    }).lean();
    await hook('success', { tran_id: p.tranId, val_id: 'FORGED', status: 'VALID' }); // validation says INVALID
    expect((await OnlinePayment.findOne({ orgId: org._id, _id: p._id }).lean()).status).toBe(
      'initiated',
    );
    expect(await Receipt.countDocuments({ orgId: org._id, mode: 'online' })).toBe(0);
  });
});

// ── Reminders ───────────────────────────────────────────────────────────────────

describe('reminders', () => {
  it('T-7 then due day, once each; log; manual reminder once a day', async () => {
    const today = todayDhaka();
    // The down payment is due 15 days after booking → 8 days from now it is 7 days away.
    const at = (days) => new Date(`${addDays(today, days)}T12:00:00+06:00`);
    const r1 = await runReminders(org._id, { now: at(8) });
    expect(r1.sent).toBe(1);
    expect((await runReminders(org._id, { now: at(8) })).sent).toBe(0);
    const log = await ReminderLog.find({ orgId: org._id }).lean();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      ruleKey: 'before_7',
      kind: 'upcoming',
      sms: { status: 'queued' },
      email: { status: 'queued' },
    });
    expect(await SmsMessage.countDocuments({ orgId: org._id, purpose: 'reminder' })).toBe(1);
    expect(
      await Job.countDocuments({
        orgId: org._id,
        type: 'email.send',
        'payload.template': 'installment_reminder',
      }),
    ).toBe(1);
    expect((await runReminders(org._id, { now: at(15) })).sent).toBe(1); // due day
    // Before the send hour nothing happens.
    expect(
      (await runReminders(org._id, { now: new Date(`${addDays(today, 30)}T08:00:00+06:00`) }))
        .skipped,
    ).toBe('before_send_hour');

    const api = await M.get(`/api/v1/reminders/log?bookingId=${booking.id}`);
    expect(api.body.data.map((x) => x.rule).sort()).toEqual(['before_7', 'due_day']);
    expect((await M.get('/api/v1/reminders/preview')).status).toBe(200);
    expect((await E.get('/api/v1/reminders/preview')).status).toBe(403);

    const now = await M.post(`/api/v1/bookings/${booking.id}/remind`);
    expect(now.status).toBe(201);
    expect(now.body.data.rule).toBe('manual');
    expect((await M.post(`/api/v1/bookings/${booking.id}/remind`)).body.error.code).toBe(
      'ALREADY_REMINDED_TODAY',
    );
  });

  it('rules are settings; switched off → nothing', async () => {
    const s = (await A.get('/api/v1/accounts/settings')).body.data;
    expect(s.reminders.rules.map((r) => r.offsetDays)).toEqual([-7, 0, 3, 15]);
    const up = await A.patch('/api/v1/accounts/settings').send({
      version: s.version,
      reminders: { enabled: false },
    });
    expect(up.body.data.reminders.enabled).toBe(false);
    expect(
      (await runReminders(org._id, { now: new Date(`${addDays(todayDhaka(), 8)}T12:00:00+06:00`) }))
        .skipped,
    ).toBe('disabled');
  });

  it('managers may change the reminder rules, nothing else in accounts settings', async () => {
    const s = (await M.get('/api/v1/accounts/settings')).body.data;
    const rules = [
      { key: 'before_3', offsetDays: -3, enabled: true, sms: true, email: false },
      { key: 'overdue_7', offsetDays: 7, enabled: true, sms: true, email: true },
    ];
    const up = await M.patch('/api/v1/accounts/settings').send({
      version: s.version,
      reminders: { sendHour: 11, rules },
    });
    expect(up.status).toBe(200);
    expect(up.body.data.reminders).toMatchObject({ sendHour: 11, rules });
    const v = up.body.data.version;
    expect(
      (await M.patch('/api/v1/accounts/settings').send({ version: v, chequeBounceFee: 0 })).status,
    ).toBe(403);
    expect(
      (
        await M.patch('/api/v1/accounts/settings').send({
          version: v,
          reminders: { enabled: false },
          portal: { slipUpload: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (await E.patch('/api/v1/accounts/settings').send({ version: v, reminders: { sendHour: 9 } }))
        .status,
    ).toBe(403);
  });
});

// ── Analytics ───────────────────────────────────────────────────────────────────

describe('analytics', () => {
  it('overview for managers; executives are refused', async () => {
    const res = await M.get('/api/v1/analytics/overview');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.inventory).toMatchObject({ units: 2, sold: 1 });
    expect(d.sales.totals).toMatchObject({ bookings: 1 });
    expect(d.sales.byMonth).toHaveLength(12);
    expect(d.collections.collected.amount).toBe(5 * LAKH);
    expect(d.collections.dues.outstanding).toBeGreaterThan(0);
    expect(d.portal.clients).toMatchObject({ invited: 1 });
    expect((await E.get('/api/v1/analytics/overview')).status).toBe(403);
    expect((await M.get('/api/v1/analytics/sales?from=2020-01-01&to=2026-12-31')).status).toBe(400);
    expect((await M.get('/api/v1/analytics/pipeline')).body.data).toHaveProperty('stages');
  });
});

it('PASSWORD constant is still the staff one', () => {
  expect(PASSWORD).not.toBe(NEW_PASSWORD);
});
