import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

let app;
let AuditLog;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ AuditLog } = await import('#modules/audit/audit.model.js'));
});
afterAll(stopDb);

let org;
let admin;
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
});

describe('audit log', () => {
  it('records who changed what, with a field diff', async () => {
    const exec = await createUser(org, { role: 'sales_executive' });
    const agent = await loginAgent(request, app, admin);
    await agent.patch(`/api/v1/users/${exec._id}`).send({ name: 'Renamed Exec' });
    const row = await AuditLog.findOne({ orgId: org._id, action: 'user.update' }).lean();
    expect(row.actor.id.toString()).toBe(String(admin._id));
    expect(row.diff.name).toEqual({ from: exec.name, to: 'Renamed Exec' });
    expect(row.requestId).toBeTruthy();
  });

  it('is append-only', async () => {
    await AuditLog.create({ orgId: org._id, action: 'x.test', actor: { kind: 'system' } });
    await expect(AuditLog.updateOne({ orgId: org._id }, { action: 'y' })).rejects.toThrow(
      /append-only/,
    );
    await expect(AuditLog.deleteMany({ orgId: org._id })).rejects.toThrow(/append-only/);
  });

  it('paginates with a cursor and filters by action prefix', async () => {
    for (let i = 0; i < 7; i++) {
      await AuditLog.create({ orgId: org._id, action: `demo.e${i}`, actor: { kind: 'system' } });
    }
    const agent = await loginAgent(request, app, admin);
    const p1 = await agent.get('/api/v1/audit?limit=3&action=demo.');
    expect(p1.body.data).toHaveLength(3);
    const p2 = await agent.get(
      `/api/v1/audit?limit=3&action=demo.&cursor=${p1.body.meta.nextCursor}`,
    );
    const p3 = await agent.get(
      `/api/v1/audit?limit=3&action=demo.&cursor=${p2.body.meta.nextCursor}`,
    );
    const ids = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((r) => r.id);
    expect(new Set(ids).size).toBe(7);
    expect(p3.body.meta.nextCursor).toBeNull();
    expect((await agent.get('/api/v1/audit?cursor=garbage')).body.error.code).toBe(
      'INVALID_CURSOR',
    );
  });

  it('is forbidden to sales executives', async () => {
    const exec = await createUser(org, { role: 'sales_executive' });
    expect((await (await loginAgent(request, app, exec)).get('/api/v1/audit')).status).toBe(403);
  });
});
