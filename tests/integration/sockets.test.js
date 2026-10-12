import { createServer } from 'node:http';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

let app;
let server;
let url;
let sockets;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  sockets = await import('#sockets/index.js');
  app = createApp();
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  sockets.initSockets(server);
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await sockets.closeSockets();
  await stopDb();
});

let admin;
let A;
let project;
let unitId;
beforeEach(async () => {
  await clearDb();
  const org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  A = await loginAgent(request, app, admin);
  project = (
    await A.post('/api/v1/projects').send({
      name: 'Live Tower',
      kind: 'apartment',
      published: true,
    })
  ).body.data;
  const block = (
    await A.post(`/api/v1/projects/${project.id}/blocks`).send({
      kind: 'building',
      code: 'A',
      name: 'A',
    })
  ).body.data;
  unitId = (
    await A.post(`/api/v1/projects/${project.id}/units`).send({
      blockId: block.id,
      floor: 1,
      position: 'A',
    })
  ).body.data.id;
});

function client(auth) {
  return new Promise((resolve, reject) => {
    const c = connect(url, { transports: ['websocket'], reconnection: false, auth });
    c.once('connect', () => resolve(c));
    c.once('connect_error', (e) => reject(e));
  });
}
const subscribe = (c, msg) => new Promise((r) => c.emit('subscribe', msg, r));
const next = (c, event) => new Promise((r) => c.once(event, r));

describe('unit:status over Socket.IO', () => {
  it('public room gets the public vocabulary; staff room gets hold details', async () => {
    const pub = await client();
    const token = (await A.post('/api/v1/auth/socket-token')).body.data.token;
    const staff = await client({ token });
    try {
      expect(await subscribe(pub, { projectId: project.id, scope: 'public' })).toEqual({
        ok: true,
      });
      expect(await subscribe(pub, { projectId: project.id, scope: 'staff' })).toMatchObject({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect(await subscribe(staff, { projectId: project.id, scope: 'staff' })).toEqual({
        ok: true,
      });

      const pubMsg = next(pub, 'unit:status');
      const staffMsg = next(staff, 'unit:status');
      await A.post(`/api/v1/units/${unitId}/hold`).send({});
      expect(await pubMsg).toEqual({ unitId, projectId: project.id, status: 'held' });
      expect(await staffMsg).toMatchObject({
        unitId,
        status: 'held',
        hold: { byName: admin.name },
      });

      const released = next(pub, 'unit:status');
      await A.post(`/api/v1/units/${unitId}/release`);
      expect((await released).status).toBe('available');
      const blocked = next(pub, 'unit:status');
      await A.post(`/api/v1/units/${unitId}/block`).send({ reason: 'landowner_share' });
      expect(await blocked).toEqual({ unitId, projectId: project.id, status: 'unavailable' });
    } finally {
      pub.close();
      staff.close();
    }
  });

  it('bad token is refused; unpublished project cannot be watched publicly', async () => {
    await expect(client({ token: 'nope' })).rejects.toMatchObject({
      data: { code: 'INVALID_SOCKET_TOKEN' },
    });
    await A.patch(`/api/v1/projects/${project.id}`).send({
      version: project.version,
      published: false,
    });
    const pub = await client();
    try {
      expect(await subscribe(pub, { projectId: project.id, scope: 'public' })).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
      });
    } finally {
      pub.close();
    }
  });
});
