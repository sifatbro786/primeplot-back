import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent, ORIGIN } from '../helpers/factory.js';

// Meta app settings must be in place before #config/env.js is first imported.
vi.hoisted(() => {
  process.env.META_APP_SECRET = 'it-app-secret';
  process.env.META_VERIFY_TOKEN = 'it-verify-token';
  process.env.SMS_COST_PER_SEGMENT_POISHA = '35';
});

const PAGE_ID = '1122334455';
const PAGE_TOKEN = 'EAAPAGE-page-token-abcdefgh';

let app;
let Lead;
let LeadActivity;
let Notification;
let Job;
let SmsMessage;
let MetaConnection;
let MetaLeadEvent;
let leads;
let sms;
let meta;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Lead } = await import('#modules/leads/lead.model.js'));
  ({ LeadActivity } = await import('#modules/leads/leadActivity.model.js'));
  ({ Notification } = await import('#modules/notifications/notification.model.js'));
  ({ Job } = await import('#jobs/job.model.js'));
  ({ SmsMessage } = await import('#modules/sms/smsMessage.model.js'));
  ({ MetaConnection } = await import('#modules/meta/metaConnection.model.js'));
  ({ MetaLeadEvent } = await import('#modules/meta/metaLeadEvent.model.js'));
  leads = await import('#modules/leads/lead.service.js');
  sms = await import('#modules/sms/sms.service.js');
  meta = await import('#modules/meta/meta.service.js');
});
afterAll(stopDb);
afterEach(() => vi.unstubAllGlobals());

let org;
let admin;
let manager;
let execA;
let A;
let M;
let EA;
beforeEach(async () => {
  await clearDb();
  org = await createOrg({ nameBn: 'অ্যাকমি প্রপার্টিজ' });
  admin = await createUser(org, { role: 'admin' });
  manager = await createUser(org, { role: 'sales_manager' });
  execA = await createUser(org, { role: 'sales_executive' });
  [A, M, EA] = await Promise.all([admin, manager, execA].map((u) => loginAgent(request, app, u)));
});

const web = (body) =>
  request(app)
    .post('/api/v1/public/leads')
    .set('Origin', ORIGIN)
    .send({ source: 'website', page: '/bn', hp: '', elapsedMs: 5000, ...body });

const smsOf = (filter = {}) => SmsMessage.find({ orgId: org._id, ...filter }).lean();

// ── Fake Graph API ──────────────────────────────────────────────────────────────

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Routes Graph calls by method + path; `leads` = leadgen id → raw lead; `forms` = form id → leads. */
function fakeGraph({ leads: rawLeads = {}, forms = {}, fail } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.split('/').slice(2).join('/'); // drop "/v25.0"
    const method = init.method ?? 'GET';
    calls.push({ method, path, auth: init.headers?.Authorization, query: u.searchParams });
    if (fail) return json(400, { error: fail });
    if (method === 'GET' && path === PAGE_ID) {
      return json(200, { id: PAGE_ID, name: 'Acme Homes', access_token: PAGE_TOKEN });
    }
    if (path === `${PAGE_ID}/subscribed_apps`) return json(200, { success: true });
    if (path === `${PAGE_ID}/leadgen_forms`) {
      return json(200, {
        data: Object.keys(forms).map((id) => ({ id, name: `Form ${id}`, status: 'ACTIVE' })),
      });
    }
    const formLeads = /^(\d+)\/leads$/.exec(path);
    if (formLeads) return json(200, { data: forms[formLeads[1]] ?? [] });
    if (rawLeads[path]) return json(200, rawLeads[path]);
    return json(400, {
      error: { message: 'Unsupported get request', code: 100, error_subcode: 33 },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const rawLead = (id, { phone = '01712345678', name = 'Rahim Uddin', formId = '555' } = {}) => ({
  id,
  created_time: '2026-10-13T10:00:00+0000',
  form_id: formId,
  ad_id: '777',
  ad_name: 'Lake View carousel',
  campaign_name: 'Lake View Oct',
  platform: 'fb',
  is_organic: false,
  field_data: [
    { name: 'full_name', values: [name] },
    ...(phone ? [{ name: 'phone_number', values: [phone] }] : []),
    { name: 'which_size?', values: ['1450 sft'] },
  ],
});

async function connect() {
  fakeGraph();
  const r = await A.put('/api/v1/integrations/meta').send({
    pageId: PAGE_ID,
    accessToken: 'EAAUSER-system-user-token-xyz',
  });
  expect(r.status).toBe(200);
  return r.body.data;
}

function signed(body) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/v1/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set(
      'X-Hub-Signature-256',
      `sha256=${createHmac('sha256', 'it-app-secret').update(raw).digest('hex')}`,
    )
    .send(raw);
}

const leadgenBody = (...ids) => ({
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: 1791900000,
      changes: ids.map((id) => ({
        field: 'leadgen',
        value: {
          leadgen_id: id,
          page_id: PAGE_ID,
          form_id: '555',
          ad_id: '777',
          created_time: 1791900000,
        },
      })),
    },
  ],
});

// ── Auto-reply ──────────────────────────────────────────────────────────────────

describe('auto-reply SMS', () => {
  it('a new website lead gets one auto-reply in the page language; the log driver "sends" it', async () => {
    expect(
      (await web({ name: 'Rahim', phone: '01712345678', page: '/en/projects/x' })).status,
    ).toBe(201);
    const [m] = await smsOf();
    expect(m).toMatchObject({
      to: '+8801712345678',
      purpose: 'lead_auto_reply',
      locale: 'en',
      status: 'queued',
      driver: 'log',
      encoding: 'gsm7',
    });
    expect(m.body).toBe(
      'Thank you Rahim! Acme Properties has received your enquiry. Our team will call you shortly.',
    );
    expect(m.costPoisha).toBe(m.segments * 35);
    expect(await Job.countDocuments({ orgId: org._id, type: 'sms.send' })).toBe(1);

    await sms.deliverSms(org._id, String(m._id));
    const sent = await SmsMessage.findOne({ orgId: org._id, _id: m._id }).lean();
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBeInstanceOf(Date);
    const act = await LeadActivity.findOne({ orgId: org._id, type: 'auto_reply' }).lean();
    expect(act.meta).toMatchObject({ status: 'sent', smsId: String(m._id) });
    // Idempotent: a second run (job retried after a crash) changes nothing.
    await sms.deliverSms(org._id, String(m._id));
    expect(await LeadActivity.countDocuments({ orgId: org._id, type: 'auto_reply' })).toBe(1);
  });

  it('Bangla by default; no SMS for repeat enquiries, manual leads, or the same phone within 24 h', async () => {
    await web({ name: 'Rahim', phone: '01712345678', page: '/projects/x' });
    await web({ name: 'Rahim', phone: '01712345678' }); // repeat enquiry
    const [m] = await smsOf();
    expect(m.locale).toBe('bn');
    expect(m.body).toContain('অ্যাকমি প্রপার্টিজ');
    expect(m.encoding).toBe('ucs2');

    await EA.post('/api/v1/leads').send({
      name: 'Walk In',
      phone: '01812345678',
      source: 'walk_in',
    });
    // Close the website lead, then the same phone enquires again → a new lead, but no 2nd SMS today.
    const lead = await Lead.findOne({ orgId: org._id, phone: '+8801712345678' }).lean();
    await Lead.updateOne(
      { orgId: org._id, _id: lead._id },
      { $set: { status: 'lost', openKey: null } },
    );
    await web({ name: 'Rahim', phone: '01712345678' });
    expect(await Lead.countDocuments({ orgId: org._id, phone: '+8801712345678' })).toBe(2);
    expect(await smsOf()).toHaveLength(1);
  });

  it('foreign numbers are logged as skipped (BD gateways only); switched off → nothing', async () => {
    await web({ name: 'Expat', phone: '+971 50 123 4567' });
    const [m] = await smsOf();
    expect(m).toMatchObject({ status: 'skipped', error: { code: 'UNSUPPORTED_DESTINATION' } });
    expect(await Job.countDocuments({ orgId: org._id, type: 'sms.send' })).toBe(0);
    expect(
      (await LeadActivity.findOne({ orgId: org._id, type: 'auto_reply' }).lean()).meta.status,
    ).toBe('skipped');

    const s = (await M.get('/api/v1/leads/settings')).body.data;
    await M.patch('/api/v1/leads/settings').send({
      version: s.version,
      autoReply: { enabled: false },
    });
    await web({ name: 'Karim', phone: '01812345678' });
    expect(await smsOf()).toHaveLength(1);
  });

  it('an auto-reply older than 30 minutes is not sent late', async () => {
    await web({ name: 'Rahim', phone: '01712345678' });
    const [m] = await smsOf();
    await SmsMessage.updateOne(
      { orgId: org._id, _id: m._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await sms.deliverSms(org._id, String(m._id));
    expect((await SmsMessage.findOne({ orgId: org._id, _id: m._id }).lean()).status).toBe(
      'skipped',
    );
  });

  it('settings refuse an auto-reply longer than 6 SMS', async () => {
    const s = (await M.get('/api/v1/leads/settings')).body.data;
    const r = await M.patch('/api/v1/leads/settings').send({
      version: s.version,
      autoReply: { textBn: 'ক'.repeat(470) },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('AUTO_REPLY_TOO_LONG');
    expect(r.body.error.details[0].path).toBe('autoReply.textBn');
  });
});

// ── SLA escalation ──────────────────────────────────────────────────────────────

describe('SLA escalation', () => {
  it('managers are told once per lead; answered leads are left alone', async () => {
    await web({ name: 'Late', phone: '01712345678' });
    await web({ name: 'Answered', phone: '01812345678' });
    const past = new Date(Date.now() - 60_000);
    await Lead.updateMany({ orgId: org._id }, { $set: { slaDueAt: past } });
    await Lead.updateOne(
      { orgId: org._id, name: 'Answered' },
      { $set: { firstResponseAt: new Date() } },
    );

    expect(await leads.escalateSlaBreaches(org._id)).toEqual({ escalated: 1 });
    expect(await leads.escalateSlaBreaches(org._id)).toEqual({ escalated: 0 });

    const n = await Notification.find({ orgId: org._id, type: 'lead.sla_breached' }).lean();
    // admin + manager hold leads:assign
    expect(n.map((x) => String(x.userId)).sort()).toEqual(
      [String(admin._id), String(manager._id)].sort(),
    );
    expect(n[0].data).toMatchObject({ name: 'Late', assigneeId: String(execA._id) });
    const late = await Lead.findOne({ orgId: org._id, name: 'Late' }).lean();
    expect(late.slaEscalatedAt).toBeInstanceOf(Date);
    expect(
      await LeadActivity.countDocuments({
        orgId: org._id,
        leadId: late._id,
        type: 'sla_escalated',
      }),
    ).toBe(1);
    const detail = (await M.get(`/api/v1/leads/${late._id}`)).body.data;
    expect(detail.slaEscalatedAt).not.toBeNull();
  });

  it('misses older than 7 days are history, not alerts', async () => {
    await web({ name: 'Old', phone: '01712345678' });
    await Lead.updateMany(
      { orgId: org._id },
      { $set: { slaDueAt: new Date(Date.now() - 8 * 86_400_000) } },
    );
    expect(await leads.escalateSlaBreaches(org._id)).toEqual({ escalated: 0 });
  });
});

// ── Integration settings & SMS endpoints ────────────────────────────────────────

describe('integration settings', () => {
  it('admins only; managers may use the SMS preview and log', async () => {
    const r = await A.get('/api/v1/integrations');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      sms: { driver: 'log', live: false, costPerSegmentPoisha: 35 },
      meta: { configured: true, connection: null, webhookPath: '/api/v1/webhooks/meta' },
    });
    expect((await M.get('/api/v1/integrations')).status).toBe(403);
    expect((await EA.get('/api/v1/integrations/sms/messages')).status).toBe(403);

    const p = await M.post('/api/v1/integrations/sms/preview').send({
      text: 'ধন্যবাদ {name}! {company}',
      locale: 'bn',
    });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({
      rendered: 'ধন্যবাদ মোহাম্মদ রহিম উদ্দিন! অ্যাকমি প্রপার্টিজ',
      encoding: 'ucs2',
      segments: 1,
      costPoisha: 35,
    });
    expect((await M.get('/api/v1/integrations/sms/messages')).status).toBe(200);
  });

  it('test SMS: BD numbers only, queued, logged and audited', async () => {
    const bad = await A.post('/api/v1/integrations/sms/test').send({ to: '+971501234567' });
    expect(bad.status).toBe(400);
    const r = await A.post('/api/v1/integrations/sms/test').send({ to: '01712345678' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ purpose: 'test', status: 'queued', to: '+8801712345678' });
    const list = (await A.get('/api/v1/integrations/sms/messages?purpose=test')).body.data;
    expect(list).toHaveLength(1);
    const audit = (await A.get('/api/v1/audit?action=integration.')).body.data;
    expect(audit.map((a) => a.action)).toContain('integration.sms.test');
  });
});

// ── Meta Lead Ads ───────────────────────────────────────────────────────────────

describe('Meta: connect', () => {
  it('stores the Page token (derived from the user token) encrypted and subscribes the app', async () => {
    const { fn, calls } = fakeGraph();
    const r = await A.put('/api/v1/integrations/meta').send({
      pageId: PAGE_ID,
      accessToken: 'EAAUSER-system-user-token-xyz',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.connection).toMatchObject({
      pageId: PAGE_ID,
      pageName: 'Acme Homes',
      status: 'active',
      tokenHint: '…efgh',
    });
    expect(JSON.stringify(r.body)).not.toContain(PAGE_TOKEN);
    const sub = calls.find((c) => c.path === `${PAGE_ID}/subscribed_apps`);
    expect(sub.method).toBe('POST');
    expect(sub.auth).toBe(`Bearer ${PAGE_TOKEN}`); // the Page token, not the user token
    expect(fn).toHaveBeenCalledTimes(2);

    const doc = await MetaConnection.findOne({ orgId: org._id }).select('+tokenEnc').lean();
    expect(doc.tokenEnc).toMatch(/^v1\./);
    expect(doc.tokenEnc).not.toContain(PAGE_TOKEN);
    expect(
      await Job.countDocuments({ orgId: org._id, type: 'meta.reconcile', dedupeKey: 'meta-sync' }),
    ).toBe(1);
    expect(
      (
        await M.put('/api/v1/integrations/meta').send({
          pageId: PAGE_ID,
          accessToken: 'x'.repeat(30),
        })
      ).status,
    ).toBe(403);
  });

  it('a bad token → 400 META_TOKEN_INVALID, nothing stored', async () => {
    fakeGraph({ fail: { message: 'Invalid OAuth access token.', code: 190 } });
    const r = await A.put('/api/v1/integrations/meta').send({
      pageId: PAGE_ID,
      accessToken: 'x'.repeat(30),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('META_TOKEN_INVALID');
    expect(await MetaConnection.countDocuments({ orgId: org._id })).toBe(0);
  });
});

describe('Meta: webhook → import', () => {
  it('verification echo, signature check, one event + one job per leadgen id', async () => {
    const v = await request(app).get(
      '/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=it-verify-token&hub.challenge=987654',
    );
    expect(v.status).toBe(200);
    expect(v.text).toBe('987654');

    await connect();
    const unsigned = await request(app).post('/api/v1/webhooks/meta').send(leadgenBody('444'));
    expect(unsigned.status).toBe(401);

    expect((await signed(leadgenBody('444'))).status).toBe(200);
    expect((await signed(leadgenBody('444'))).status).toBe(200); // Meta retry
    expect(await MetaLeadEvent.countDocuments({ orgId: org._id })).toBe(1);
    expect(await Job.countDocuments({ orgId: org._id, type: 'meta.fetchLead' })).toBe(1);

    // A Page we don't know is ignored.
    const other = leadgenBody('999');
    other.entry[0].changes[0].value.page_id = '5555';
    expect((await signed(other)).status).toBe(200);
    expect(await MetaLeadEvent.countDocuments({ orgId: org._id })).toBe(1);
  });

  it('imports the lead with source, campaign, answers; round-robin, SLA and auto-reply apply', async () => {
    await connect();
    await signed(leadgenBody('444'));
    fakeGraph({ leads: { 444: rawLead('444') } });

    expect(await meta.processLeadEvent(org._id, '444')).toMatchObject({ status: 'imported' });
    const lead = await Lead.findOne({ orgId: org._id }).lean();
    expect(lead).toMatchObject({
      name: 'Rahim Uddin',
      phone: '+8801712345678',
      source: 'facebook',
      type: 'buyer',
      message: 'Which size?: 1450 sft',
      sourceDetail: { campaign: 'Lake View Oct', medium: 'meta / paid', formName: 'Form 555' },
    });
    expect(String(lead.assigneeId)).toBe(String(execA._id));
    expect(lead.slaDueAt).toBeInstanceOf(Date);
    const ev = await MetaLeadEvent.findOne({ orgId: org._id, leadgenId: '444' }).lean();
    expect(ev).toMatchObject({ status: 'imported', attempts: 1 });
    expect(String(ev.leadId)).toBe(String(lead._id));
    expect(await LeadActivity.countDocuments({ orgId: org._id, type: 'meta_lead' })).toBe(1);
    expect(await smsOf({ purpose: 'lead_auto_reply' })).toHaveLength(1);

    // Already imported → a second run does nothing.
    expect(await meta.processLeadEvent(org._id, '444')).toEqual({ status: 'skipped' });
    expect(await Lead.countDocuments({ orgId: org._id })).toBe(1);
  });

  it('same phone again → repeat enquiry on the open lead; a form without a phone fails clearly', async () => {
    await connect();
    await signed(leadgenBody('444', '445', '446'));
    fakeGraph({
      leads: {
        444: rawLead('444'),
        445: rawLead('445', { phone: '+880 1712-345678', name: 'Rahim' }),
        446: rawLead('446', { phone: null }),
      },
    });
    await meta.processLeadEvent(org._id, '444');
    expect(await meta.processLeadEvent(org._id, '445')).toMatchObject({ status: 'duplicate' });
    expect((await Lead.findOne({ orgId: org._id }).lean()).enquiryCount).toBe(2);
    expect(await meta.processLeadEvent(org._id, '446')).toEqual({ status: 'failed' });
    const failed = await MetaLeadEvent.findOne({ orgId: org._id, leadgenId: '446' }).lean();
    expect(failed.error).toMatchObject({ code: 'NO_PHONE', permanent: true });

    const log = (await A.get('/api/v1/integrations/meta/leads')).body.data;
    expect(log.map((e) => e.status).sort()).toEqual(['duplicate', 'failed', 'imported']);
    expect(log.find((e) => e.status === 'imported').leadName).toBe('Rahim Uddin');
  });

  it('form mapping sends a form to the landowner pipeline and a project', async () => {
    await connect();
    const conn = (await A.get('/api/v1/integrations')).body.data.meta.connection;
    const r = await A.put('/api/v1/integrations/meta/forms').send({
      version: conn.version,
      mappings: [{ formId: '555', formName: 'Land owners JV', type: 'landowner' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.formMappings).toEqual([
      { formId: '555', formName: 'Land owners JV', type: 'landowner', projectId: null },
    ]);
    await signed(leadgenBody('500'));
    fakeGraph({ leads: { 500: rawLead('500') } });
    await meta.processLeadEvent(org._id, '500');
    const lead = await Lead.findOne({ orgId: org._id }).lean();
    expect(lead.type).toBe('landowner');
    expect(lead.sourceDetail.formName).toBe('Land owners JV');
    // Stale version → 409
    expect(
      (await A.put('/api/v1/integrations/meta/forms').send({ version: conn.version, mappings: [] }))
        .status,
    ).toBe(409);
  });

  it('an expired token marks the connection broken, alerts admins once, and can be retried', async () => {
    await connect();
    await signed(leadgenBody('444'));
    fakeGraph({
      fail: {
        message: 'Error validating access token: Session has expired',
        code: 190,
        error_subcode: 463,
      },
    });
    await expect(meta.processLeadEvent(org._id, '444')).rejects.toThrow(/expired/);
    const conn = await MetaConnection.findOne({ orgId: org._id }).lean();
    expect(conn.status).toBe('error');
    expect(conn.lastError.code).toBe('META_TOKEN_INVALID');
    const alerts = await Notification.find({ orgId: org._id, type: 'integration.error' }).lean();
    expect(alerts.map((a) => String(a.userId))).toEqual([String(admin._id)]);
    const ev = await MetaLeadEvent.findOne({ orgId: org._id, leadgenId: '444' }).lean();
    expect(ev).toMatchObject({ status: 'failed', error: { permanent: false } });

    // Fix the token (reconnect), then retry from the log.
    await connect();
    const r = await A.post(`/api/v1/integrations/meta/leads/${ev._id}/retry`);
    expect(r.status).toBe(200);
    fakeGraph({ leads: { 444: rawLead('444') } });
    expect(await meta.processLeadEvent(org._id, '444')).toMatchObject({ status: 'imported' });
  });

  it('reconcile imports leads whose webhook never came, and skips known ones', async () => {
    await connect();
    await signed(leadgenBody('444'));
    fakeGraph({ leads: { 444: rawLead('444') } });
    await meta.processLeadEvent(org._id, '444');

    fakeGraph({
      forms: {
        555: [rawLead('444'), rawLead('600', { phone: '01912345678', name: 'Missed One' })],
      },
    });
    const sum = await meta.reconcile(org._id, { force: true });
    expect(sum).toMatchObject({ checked: 2, imported: 1, failed: 0, error: null });
    expect(await Lead.countDocuments({ orgId: org._id })).toBe(2);
    expect((await MetaLeadEvent.findOne({ orgId: org._id, leadgenId: '600' }).lean()).via).toBe(
      'reconcile',
    );
    expect(
      (await MetaConnection.findOne({ orgId: org._id }).lean()).lastReconciledAt,
    ).toBeInstanceOf(Date);
    // Not forced and just ran → not due.
    expect(await meta.reconcile(org._id)).toEqual({ skipped: 'not_due' });
  });

  it('disconnect unsubscribes and removes the Page', async () => {
    await connect();
    const { calls } = fakeGraph();
    expect((await A.delete('/api/v1/integrations/meta')).status).toBe(204);
    expect(
      calls.some((c) => c.method === 'DELETE' && c.path === `${PAGE_ID}/subscribed_apps`),
    ).toBe(true);
    expect(await MetaConnection.countDocuments({ orgId: org._id })).toBe(0);
    expect((await A.delete('/api/v1/integrations/meta')).status).toBe(404);
  });
});
