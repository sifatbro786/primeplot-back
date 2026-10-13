import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent, ORIGIN } from '../helpers/factory.js';

let app;
let Lead;
let Notification;
let LeadTask;
let followups;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Lead } = await import('#modules/leads/lead.model.js'));
  ({ LeadTask } = await import('#modules/leads/leadTask.model.js'));
  ({ Notification } = await import('#modules/notifications/notification.model.js'));
  followups = await import('#modules/leads/followup.service.js');
});
afterAll(stopDb);

let org;
let admin;
let manager;
let execA;
let execB;
let A; // admin
let M; // manager
let EA; // executive A
let EB; // executive B
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  manager = await createUser(org, { role: 'sales_manager' });
  execA = await createUser(org, { role: 'sales_executive' });
  execB = await createUser(org, { role: 'sales_executive' });
  [A, M, EA, EB] = await Promise.all(
    [admin, manager, execA, execB].map((u) => loginAgent(request, app, u)),
  );
});

const web = (body) =>
  request(app)
    .post('/api/v1/public/leads')
    .set('Origin', ORIGIN)
    .send({ source: 'website', page: '/bn', hp: '', elapsedMs: 5000, ...body });

async function onlyLead(filter = {}) {
  const rows = await Lead.find({ orgId: org._id, ...filter }).lean();
  expect(rows).toHaveLength(1);
  return rows[0];
}

const boardOf = async (agent, type = 'buyer') =>
  (await agent.get(`/api/v1/leads/board?type=${type}`)).body.data;
const stageByKey = (board, key) => board.stages.find((s) => s.key === key);

describe('website intake', () => {
  it('creates a lead in "New", round-robins owners, sets the SLA clock and notifies', async () => {
    expect((await web({ name: 'Rahim', phone: '01712345678', message: '3 bed' })).status).toBe(201);
    expect((await web({ name: 'Karim', phone: '01812345678' })).status).toBe(201);
    expect((await web({ name: 'Salam', phone: '01912345678' })).status).toBe(201);

    const leads = await Lead.find({ orgId: org._id }).sort({ createdAt: 1 }).lean();
    expect(leads.map((l) => l.phone)).toEqual([
      '+8801712345678',
      '+8801812345678',
      '+8801912345678',
    ]);
    const owners = leads.map((l) => String(l.assigneeId));
    expect(new Set(owners.slice(0, 2)).size).toBe(2); // two executives take turns
    expect(owners[2]).toBe(owners[0]);
    expect(owners.every((o) => [String(execA._id), String(execB._id)].includes(o))).toBe(true);
    expect(leads.every((l) => l.slaDueAt instanceof Date && l.status === 'open')).toBe(true);

    const board = await boardOf(M);
    expect(stageByKey(board, 'new').count).toBe(3);
    // Newest on top of the column.
    expect(stageByKey(board, 'new').leads[0].name).toBe('Salam');

    const n = await Notification.find({ orgId: org._id, type: 'lead.assigned' }).lean();
    expect(n).toHaveLength(3);
  });

  it('a repeat enquiry from the same phone joins the open lead', async () => {
    await web({ name: 'Rahim', phone: '01712345678' });
    await web({
      name: 'Rahim Uddin',
      phone: '+880 1712-345678',
      email: 'r@x.com',
      message: 'still interested',
    });
    const lead = await onlyLead();
    expect(lead.enquiryCount).toBe(2);
    expect(lead.email).toBe('r@x.com'); // empty field filled
    expect(lead.name).toBe('Rahim'); // existing data kept

    const acts = (await M.get(`/api/v1/leads/${lead._id}/activities`)).body.data;
    expect(acts.map((a) => a.type)).toEqual(
      expect.arrayContaining(['enquiry', 'created', 'assigned']),
    );
    expect(await Notification.countDocuments({ orgId: org._id, type: 'lead.enquiry' })).toBe(1);
  });

  it('simultaneous enquiries from one phone make exactly one lead', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => web({ name: 'Rahim', phone: '01712345678' })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const lead = await onlyLead();
    expect(lead.enquiryCount).toBe(6);
  });

  it('bots get a 201 and nothing is stored', async () => {
    expect((await web({ name: 'Bot', phone: '01712345678', hp: 'http://spam' })).status).toBe(201);
    expect((await web({ name: 'Bot', phone: '01712345678', elapsedMs: 300 })).status).toBe(201);
    expect(await Lead.countDocuments({ orgId: org._id })).toBe(0);
  });

  it('invalid phone → 400 INVALID_PHONE; unknown fields → 422', async () => {
    const bad = await web({ name: 'Rahim', phone: '0171234' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PHONE');
    expect(
      (await web({ name: 'Rahim', phone: '01712345678', assigneeId: String(execA._id) })).status,
    ).toBe(422);
  });

  it('landowner form lands in its own pipeline with land details (katha → all units)', async () => {
    await web({
      type: 'landowner',
      name: 'Jomir Malik',
      phone: '01612345678',
      land: {
        location: 'Purbachal',
        area: { value: 5, unit: 'katha' },
        roadWidthFt: 30,
        mutation: 'done',
      },
    });
    const lead = await onlyLead();
    expect(lead.type).toBe('landowner');
    expect(lead.land.area).toMatchObject({ value: 5, unit: 'katha', sqft: 3600 });
    const board = await boardOf(M, 'landowner');
    expect(board.stages.map((s) => s.key)).toContain('inspection');
    expect(stageByKey(board, 'new').count).toBe(1);
    expect(stageByKey(await boardOf(M), 'new').count).toBe(0);
  });

  it('manual mode: nobody is auto-assigned; managers are told', async () => {
    const s = (await M.get('/api/v1/leads/settings')).body.data;
    expect(
      (
        await M.patch('/api/v1/leads/settings').send({
          version: s.version,
          assignment: { mode: 'manual' },
        })
      ).status,
    ).toBe(200);
    await web({ name: 'Rahim', phone: '01712345678' });
    const lead = await onlyLead();
    expect(lead.assigneeId).toBeNull();
    const told = await Notification.find({ orgId: org._id, type: 'lead.unassigned' }).lean();
    expect(told.map((n) => String(n.userId)).sort()).toEqual(
      [String(admin._id), String(manager._id)].sort(),
    );
  });
});

describe('visibility & manual entry', () => {
  it('executives see only their own leads (others are 404)', async () => {
    const mine = (await EA.post('/api/v1/leads').send({ name: 'Mine', phone: '01712345678' })).body
      .data;
    const theirs = (await EB.post('/api/v1/leads').send({ name: 'Theirs', phone: '01812345678' }))
      .body.data;
    expect(mine.assigneeId).toBe(String(execA._id)); // executives own what they enter

    const list = (await EA.get('/api/v1/leads')).body.data;
    expect(list.map((l) => l.id)).toEqual([mine.id]);
    expect((await EA.get(`/api/v1/leads/${theirs.id}`)).status).toBe(404);
    expect((await EA.get(`/api/v1/leads?assignee=${execB._id}`)).status).toBe(403);
    expect((await M.get('/api/v1/leads')).body.data).toHaveLength(2);
  });

  it('a duplicate phone → 409 DUPLICATE_LEAD (lead id only for those who can see it)', async () => {
    const first = (await EA.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' }))
      .body.data;
    const dupMgr = await M.post('/api/v1/leads').send({ name: 'Rahim', phone: '+8801712345678' });
    expect(dupMgr.status).toBe(409);
    expect(dupMgr.body.error.code).toBe('DUPLICATE_LEAD');
    expect(dupMgr.body.error.details[0].leadId).toBe(first.id);
    const dupOther = await EB.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' });
    expect(dupOther.status).toBe(409);
    expect(dupOther.body.error.details[0].leadId).toBeUndefined();
    // Same phone as a landowner is a different lead.
    expect(
      (
        await EA.post('/api/v1/leads').send({
          type: 'landowner',
          name: 'Rahim',
          phone: '01712345678',
        })
      ).status,
    ).toBe(201);
  });

  it('accepts international numbers (NRB buyers)', async () => {
    const r = await EA.post('/api/v1/leads').send({
      name: 'Expat',
      phone: '+971 50 123 4567',
      source: 'phone',
    });
    expect(r.status).toBe(201);
    expect(r.body.data.phone).toBe('+971501234567');
  });

  it('only managers assign to others; executives cannot create for someone else', async () => {
    expect(
      (
        await EA.post('/api/v1/leads').send({
          name: 'X',
          phone: '01712345678',
          assigneeId: String(execB._id),
        })
      ).status,
    ).toBe(403);
    const r = await M.post('/api/v1/leads').send({
      name: 'X',
      phone: '01712345678',
      assigneeId: String(execB._id),
    });
    expect(r.status).toBe(201);
    expect(r.body.data.assigneeName).toBe(execB.name);
  });

  it('search by name and phone digits; filters', async () => {
    await EA.post('/api/v1/leads').send({
      name: 'Rahim Uddin',
      phone: '01712345678',
      tags: ['vip'],
    });
    await EA.post('/api/v1/leads').send({ name: 'Karim', phone: '01898765432' });
    expect((await M.get('/api/v1/leads?q=rahim')).body.data).toHaveLength(1);
    expect((await M.get('/api/v1/leads?q=98765')).body.data[0].name).toBe('Karim');
    expect((await M.get('/api/v1/leads?tag=vip')).body.data).toHaveLength(1);
    expect((await M.get('/api/v1/leads?assignee=unassigned')).body.data).toHaveLength(0);
  });
});

describe('pipeline moves', () => {
  async function newLead(agent = EA, phone = '01712345678') {
    return (await agent.post('/api/v1/leads').send({ name: 'Rahim', phone })).body.data;
  }

  it('moving out of "New" is the first response; lost needs a reason and closes the lead', async () => {
    const lead = await newLead();
    const board = await boardOf(EA);
    const contacted = stageByKey(board, 'contacted');
    const moved = await EA.post(`/api/v1/leads/${lead.id}/move`).send({
      version: lead.version,
      stageId: contacted.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data.firstResponseAt).toBeTruthy();
    expect(moved.body.data.stage.key).toBe('contacted');

    const lost = stageByKey(board, 'lost');
    const noReason = await EA.post(`/api/v1/leads/${lead.id}/move`).send({
      version: moved.body.data.version,
      stageId: lost.id,
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('LOST_REASON_REQUIRED');

    const closed = await EA.post(`/api/v1/leads/${lead.id}/move`).send({
      version: moved.body.data.version,
      stageId: lost.id,
      lostReason: 'budget',
    });
    expect(closed.body.data).toMatchObject({ status: 'lost', lostReason: 'budget' });

    // The same person enquiring again starts a fresh lead linked to the old one.
    await web({ name: 'Rahim', phone: '01712345678' });
    const fresh = await Lead.findOne({ orgId: org._id, status: 'open' }).lean();
    expect(String(fresh.previousLeadId)).toBe(lead.id);

    // Reopening the old one now clashes with the fresh open lead.
    const reopen = await M.post(`/api/v1/leads/${lead.id}/move`).send({
      version: closed.body.data.version,
      stageId: contacted.id,
    });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('DUPLICATE_LEAD');
  });

  it('a stale version → 409; ordering inside a column follows afterId/beforeId', async () => {
    const a = await newLead(EA, '01712345671');
    const b = await newLead(EA, '01712345672');
    const c = await newLead(EA, '01712345673');
    const newCol = stageByKey(await boardOf(EA), 'new');
    expect(newCol.leads.map((l) => l.id)).toEqual([c.id, b.id, a.id]);

    // Put A between C and B.
    const r = await EA.post(`/api/v1/leads/${a.id}/move`).send({
      version: a.version,
      stageId: newCol.id,
      afterId: c.id,
      beforeId: b.id,
    });
    expect(r.status).toBe(200);
    expect(stageByKey(await boardOf(EA), 'new').leads.map((l) => l.id)).toEqual([c.id, a.id, b.id]);

    const stale = await EA.post(`/api/v1/leads/${a.id}/move`).send({
      version: a.version,
      stageId: newCol.id,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');

    const wrongCol = stageByKey(await boardOf(EA), 'contacted');
    const badPos = await EA.post(`/api/v1/leads/${b.id}/move`).send({
      version: b.version,
      stageId: wrongCol.id,
      afterId: c.id,
    });
    expect(badPos.status).toBe(409);
    expect(badPos.body.error.code).toBe('STALE_POSITION');
  });

  it('edits need the current version and keep the dedupe key in step with the phone', async () => {
    const a = await newLead(EA, '01712345671');
    await newLead(EA, '01712345672');
    const clash = await EA.patch(`/api/v1/leads/${a.id}`).send({
      version: a.version,
      phone: '01712345672',
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DUPLICATE_LEAD');
    const okEdit = await EA.patch(`/api/v1/leads/${a.id}`).send({
      version: a.version,
      phone: '01712345679',
      tags: ['hot'],
    });
    expect(okEdit.status).toBe(200);
    expect(okEdit.body.data).toMatchObject({ phone: '+8801712345679', tags: ['hot'] });
    expect(
      (await EA.patch(`/api/v1/leads/${a.id}`).send({ version: a.version, name: 'Old' })).status,
    ).toBe(409);
  });
});

describe('activities, tasks, reminders', () => {
  it('a logged call sets the first response; tasks drive the next follow-up and remind once', async () => {
    const lead = (await EA.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' })).body
      .data;
    const call = await EA.post(`/api/v1/leads/${lead.id}/activities`).send({
      type: 'call',
      outcome: 'connected',
      durationSec: 120,
      body: 'Wants 3 bed',
    });
    expect(call.status).toBe(201);
    expect((await EA.get(`/api/v1/leads/${lead.id}`)).body.data.firstResponseAt).toBeTruthy();
    expect(
      (await EA.post(`/api/v1/leads/${lead.id}/activities`).send({ type: 'note' })).status,
    ).toBe(422);

    const due = new Date(Date.now() + 10 * 60_000).toISOString();
    const task = await EA.post(`/api/v1/leads/${lead.id}/tasks`).send({
      title: 'Call back',
      dueAt: due,
      remindMinutesBefore: 15,
    });
    expect(task.status).toBe(201);
    expect((await EA.get(`/api/v1/leads/${lead.id}`)).body.data.nextFollowUpAt).toBe(due);
    const mine = (await EA.get('/api/v1/leads/tasks')).body.data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Call back', leadName: 'Rahim', status: 'open' });

    // Reminder time (due − 15 min) has passed → exactly one notification, even if the sweep runs twice.
    await followups.sendDueReminders(org._id);
    await followups.sendDueReminders(org._id);
    expect(
      await Notification.countDocuments({ orgId: org._id, type: 'task.due', userId: execA._id }),
    ).toBe(1);

    const done = await EA.patch(`/api/v1/leads/tasks/${task.body.data.id}`).send({
      version: task.body.data.version,
      status: 'done',
    });
    expect(done.status).toBe(200);
    expect((await EA.get(`/api/v1/leads/${lead.id}`)).body.data.nextFollowUpAt).toBeNull();
    const types = (await EA.get(`/api/v1/leads/${lead.id}/activities`)).body.data.map(
      (a) => a.type,
    );
    expect(types).toEqual(expect.arrayContaining(['call', 'task_created', 'task_done']));
  });

  it('executives cannot see or change other people’s tasks', async () => {
    const lead = (await EA.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' })).body
      .data;
    const task = (
      await EA.post(`/api/v1/leads/${lead.id}/tasks`).send({
        title: 'Visit',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
    ).body.data;
    expect(
      (
        await EB.patch(`/api/v1/leads/tasks/${task.id}`).send({
          version: task.version,
          status: 'done',
        })
      ).status,
    ).toBe(404);
    expect((await EB.get('/api/v1/leads/tasks?scope=all')).status).toBe(403);
    expect((await M.get('/api/v1/leads/tasks?scope=all')).body.data).toHaveLength(1);
  });
});

describe('assignment & merge', () => {
  it('reassigning moves open tasks, notifies the new owner and is audited', async () => {
    const lead = (await EA.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' })).body
      .data;
    await EA.post(`/api/v1/leads/${lead.id}/tasks`).send({
      title: 'Call',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(
      (
        await EA.post(`/api/v1/leads/${lead.id}/assign`).send({
          version: lead.version,
          assigneeId: String(execB._id),
        })
      ).status,
    ).toBe(403);

    const r = await M.post(`/api/v1/leads/${lead.id}/assign`).send({
      version: lead.version,
      assigneeId: String(execB._id),
    });
    expect(r.status).toBe(200);
    expect(r.body.data.assigneeId).toBe(String(execB._id));
    const task = await LeadTask.findOne({ orgId: org._id }).lean();
    expect(String(task.assigneeId)).toBe(String(execB._id));
    expect(
      await Notification.countDocuments({
        orgId: org._id,
        userId: execB._id,
        type: 'lead.assigned',
      }),
    ).toBe(1);
    expect((await EA.get(`/api/v1/leads/${lead.id}`)).status).toBe(404);
    const audit = (await A.get('/api/v1/audit?action=lead.')).body.data;
    expect(audit.map((a) => a.action)).toContain('lead.assign');
  });

  it('bulk assign and unassign', async () => {
    const ids = [];
    for (const p of ['01712345671', '01712345672', '01712345673']) {
      ids.push(
        (await M.post('/api/v1/leads').send({ name: 'X', phone: p, assigneeId: null })).body.data
          .id,
      );
    }
    expect(
      (await M.post('/api/v1/leads/assign').send({ ids, assigneeId: String(execA._id) })).body.data
        .updated,
    ).toBe(3);
    expect((await EA.get('/api/v1/leads')).body.data).toHaveLength(3);
  });

  it('merge moves the timeline, adds enquiries and hides the source', async () => {
    const t = (await M.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' })).body
      .data;
    const s = (
      await M.post('/api/v1/leads').send({
        name: 'Rahim (office)',
        phone: '01812345678',
        email: 'r@x.com',
      })
    ).body.data;
    await M.post(`/api/v1/leads/${s.id}/activities`).send({
      type: 'note',
      body: 'Met at the fair',
    });
    const r = await M.post(`/api/v1/leads/${t.id}/merge`).send({ sourceId: s.id });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      enquiryCount: 2,
      email: 'r@x.com',
      altPhone: '+8801812345678',
    });
    expect((await M.get(`/api/v1/leads/${s.id}`)).status).toBe(404);
    const acts = (await M.get(`/api/v1/leads/${t.id}/activities`)).body.data.map((a) => a.type);
    expect(acts).toEqual(expect.arrayContaining(['merged', 'note']));
    // The source's phone is free again.
    expect((await M.post('/api/v1/leads').send({ name: 'New', phone: '01812345678' })).status).toBe(
      201,
    );
  });
});

describe('pipeline settings & export', () => {
  it('stages can be renamed/added; a stage with leads cannot be removed', async () => {
    const lead = (await EA.post('/api/v1/leads').send({ name: 'Rahim', phone: '01712345678' })).body
      .data;
    const stages = (await M.get('/api/v1/leads/stages?type=buyer')).body.data;
    expect(stages.find((s) => s.key === 'new').count).toBe(1);
    const next = stages.map(({ id, name, nameBn, kind, color }) => ({
      id,
      name,
      nameBn,
      kind,
      color,
    }));
    next.splice(2, 0, { name: 'Brochure sent', kind: 'open' });
    next[0].name = 'Fresh';
    const r = await M.put('/api/v1/leads/stages').send({ pipeline: 'buyer', stages: next });
    expect(r.status).toBe(200);
    expect(r.body.data.map((s) => s.name)).toContain('Brochure sent');
    expect(r.body.data[0]).toMatchObject({ name: 'Fresh', key: 'new' });

    const removeNew = next.filter((s) => s.name !== 'Fresh');
    const blocked = await M.put('/api/v1/leads/stages').send({
      pipeline: 'buyer',
      stages: removeNew,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('STAGE_IN_USE');
    expect(
      (await EA.put('/api/v1/leads/stages').send({ pipeline: 'buyer', stages: next })).status,
    ).toBe(403);
    expect(lead).toBeTruthy();
  });

  it('settings: version checked, office hours validated', async () => {
    const s = (await M.get('/api/v1/leads/settings')).body.data;
    expect(s).toMatchObject({
      assignment: { mode: 'round_robin' },
      sla: { firstResponseMinutes: 30, weekend: [5] },
      autoReply: { enabled: true },
    });
    expect(
      (
        await M.patch('/api/v1/leads/settings').send({
          version: s.version,
          sla: { officeStart: '21:00' },
        })
      ).status,
    ).toBe(400);
    const ok = await M.patch('/api/v1/leads/settings').send({
      version: s.version,
      sla: { firstResponseMinutes: 15 },
    });
    expect(ok.status).toBe(200);
    expect(
      (
        await M.patch('/api/v1/leads/settings').send({
          version: s.version,
          sla: { firstResponseMinutes: 20 },
        })
      ).status,
    ).toBe(409);
  });

  it('CSV export: managers only, Bangla-safe BOM, formulas neutralised', async () => {
    await EA.post('/api/v1/leads').send({ name: '=HYPERLINK("x")', phone: '01712345678' });
    expect((await EA.get('/api/v1/leads/export')).status).toBe(403);
    const r = await M.get('/api/v1/leads/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.replace(/^\uFEFF/, '').startsWith('Created,Name,Phone')).toBe(true);
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('notifications', () => {
  it('list, unread count, mark read — own only', async () => {
    await web({ name: 'Rahim', phone: '01712345678' });
    await web({ name: 'Karim', phone: '01812345678' });
    const countA = (await EA.get('/api/v1/notifications/unread-count')).body.data.count;
    const countB = (await EB.get('/api/v1/notifications/unread-count')).body.data.count;
    expect(countA + countB).toBe(2);
    const agent = countA ? EA : EB;
    const list = (await agent.get('/api/v1/notifications')).body.data;
    expect(list[0]).toMatchObject({ type: 'lead.assigned', readAt: null });
    expect(
      (await agent.post('/api/v1/notifications/read').send({ all: true })).body.data.updated,
    ).toBe(1);
    expect((await agent.get('/api/v1/notifications/unread-count')).body.data.count).toBe(0);
  });
});
