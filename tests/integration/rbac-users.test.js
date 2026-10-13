import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

let app;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});
afterAll(stopDb);

let org;
let admin;
let manager;
let exec;
let client;
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  manager = await createUser(org, { role: 'sales_manager' });
  exec = await createUser(org, { role: 'sales_executive' });
  client = await createUser(org, { role: 'client' });
});

describe('permission checks', () => {
  it.each([
    ['admin', 200],
    ['sales_manager', 200],
    ['sales_executive', 403],
    ['client', 403],
  ])('GET /users as %s → %i', async (role, status) => {
    const user = { admin, sales_manager: manager, sales_executive: exec, client }[role];
    const agent = await loginAgent(request, app, user);
    expect((await agent.get('/api/v1/users')).status).toBe(status);
  });

  it('only admin can create users', async () => {
    const body = { name: 'X Person', email: 'x@example.com', role: 'sales_executive' };
    expect(
      (await (await loginAgent(request, app, manager)).post('/api/v1/users').send(body)).status,
    ).toBe(403);
    expect(
      (await (await loginAgent(request, app, admin)).post('/api/v1/users').send(body)).status,
    ).toBe(201);
  });

  it('duplicate email → 409 DUPLICATE', async () => {
    const agent = await loginAgent(request, app, admin);
    const res = await agent
      .post('/api/v1/users')
      .send({ name: 'Dup', email: exec.email, role: 'client' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
  });

  it('lists with search + pagination meta', async () => {
    const agent = await loginAgent(request, app, admin);
    const res = await agent.get('/api/v1/users?limit=2&page=1');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 2, total: 4, pages: 2 });
    const q = await agent.get(`/api/v1/users?q=${encodeURIComponent(exec.email)}`);
    expect(q.body.data.map((u) => u.id)).toEqual([String(exec._id)]);
    expect((await agent.get('/api/v1/users?q[$ne]=x')).status).toBe(422);
  });
});

describe('admin edits', () => {
  it('role change takes effect immediately for the affected user', async () => {
    const execAgent = await loginAgent(request, app, exec);
    expect((await execAgent.get('/api/v1/auth/me')).status).toBe(200);
    const adminAgent = await loginAgent(request, app, admin);
    const res = await adminAgent.patch(`/api/v1/users/${exec._id}`).send({ role: 'sales_manager' });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('sales_manager');
    expect((await execAgent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('disabling a user kills their session', async () => {
    const execAgent = await loginAgent(request, app, exec);
    const adminAgent = await loginAgent(request, app, admin);
    await adminAgent.patch(`/api/v1/users/${exec._id}`).send({ status: 'disabled' });
    const res = await execAgent.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('cannot change own role or status', async () => {
    const adminAgent = await loginAgent(request, app, admin);
    const self = await adminAgent.patch(`/api/v1/users/${admin._id}`).send({ status: 'disabled' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_CHANGE');
  });

  it('an admin can be disabled while another active admin remains', async () => {
    const admin2 = await createUser(org, { role: 'admin' });
    const a2 = await loginAgent(request, app, admin2);
    expect((await a2.patch(`/api/v1/users/${admin._id}`).send({ status: 'disabled' })).status).toBe(
      200,
    );
  });

  it('service guard: the last active admin can never be demoted or disabled', async () => {
    // Through the API the actor is always another active admin, so this is defence-in-depth
    // against races and future code paths (e.g. a system job).
    const { updateUser } = await import('#modules/users/user.service.js');
    const ctx = { orgId: org._id, actor: { id: '64b000000000000000000099', kind: 'system' } };
    await expect(
      updateUser({ orgId: org._id, id: admin._id, patch: { role: 'client' }, ctx }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(
      updateUser({ orgId: org._id, id: admin._id, patch: { status: 'disabled' }, ctx }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });
});

describe('organization', () => {
  it('public branding needs no auth; edit needs org:update', async () => {
    const pub = await request(app).get('/api/v1/org/public');
    expect(pub.status).toBe(200);
    expect(pub.body.data.name).toBe('Acme Properties');
    expect(pub.body.data.features).toEqual({ onlinePayment: false });
    expect(pub.body.data).toMatchObject({ logo: null, tradeLicenseNo: null, rehabMemberNo: null });

    const mgr = await loginAgent(request, app, manager);
    expect((await mgr.patch('/api/v1/org').send({ nameBn: 'অ্যাকমি' })).status).toBe(403);
    const adm = await loginAgent(request, app, admin);
    const res = await adm.patch('/api/v1/org').send({ nameBn: 'অ্যাকমি', phone: '01812345678' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ nameBn: 'অ্যাকমি', phone: '+8801812345678' });
  });

  it('tracking IDs: validated, normalised, clearable, shown on /org/public', async () => {
    const adm = await loginAgent(request, app, admin);
    const bad = await adm
      .patch('/api/v1/org')
      .send({ analytics: { ga4MeasurementId: 'UA-123-1', metaPixelId: '12ab' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const set = await adm
      .patch('/api/v1/org')
      .send({ analytics: { ga4MeasurementId: ' g-abc123xyz9 ', metaPixelId: '123456789012345' } });
    expect(set.status).toBe(200);
    expect(set.body.data.analytics).toEqual({
      ga4MeasurementId: 'G-ABC123XYZ9',
      metaPixelId: '123456789012345',
    });
    const pub = await request(app).get('/api/v1/org/public');
    expect(pub.body.data.analytics.ga4MeasurementId).toBe('G-ABC123XYZ9');

    // Clearing one keeps the other.
    const cleared = await adm.patch('/api/v1/org').send({ analytics: { ga4MeasurementId: '' } });
    expect(cleared.body.data.analytics).toEqual({
      ga4MeasurementId: null,
      metaPixelId: '123456789012345',
    });
  });
});
