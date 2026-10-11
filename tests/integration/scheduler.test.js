import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg } from '../helpers/factory.js';

let Job;
let sched;
let registry;
const calls = [];

beforeAll(async () => {
  await startDb();
  ({ Job } = await import('#jobs/job.model.js'));
  registry = await import('#jobs/registry.js');
  sched = await import('#jobs/scheduler.js');
  registry.defineJob({ type: 'test.ok', handler: async (p) => calls.push(p.n) });
  registry.defineJob({
    type: 'test.fail',
    maxAttempts: 2,
    handler: async () => {
      throw new Error('boom');
    },
  });
  registry.defineJob({
    type: 'test.permanent',
    handler: async () => {
      throw new registry.PermanentJobError('bad input');
    },
  });
  registry.defineJob({
    type: 'test.slow',
    timeoutMs: 50,
    maxAttempts: 1,
    handler: () => new Promise(() => {}),
  });
});
afterAll(stopDb);

let org;
beforeEach(async () => {
  await clearDb();
  calls.length = 0;
  org = await createOrg();
});

const get = (id) => Job.findOne({ orgId: org._id, _id: id }).lean();

describe('claim', () => {
  it('50 concurrent claimers over 20 jobs: every job claimed exactly once', async () => {
    for (let n = 0; n < 20; n++)
      await sched.enqueue({ orgId: org._id, type: 'test.ok', payload: { n } });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => sched.claimNext({ workerId: `w${i}` })),
    );
    const claimed = results.filter(Boolean).map((j) => String(j._id));
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed).size).toBe(20);
    const running = await Job.find({ orgId: org._id, status: 'running' }).lean();
    expect(running.every((j) => j.attempts === 1)).toBe(true);
  });

  it('respects runAt and priority', async () => {
    await sched.enqueue({
      orgId: org._id,
      type: 'test.ok',
      payload: { n: 'later' },
      runAt: new Date(Date.now() + 60_000),
    });
    await sched.enqueue({ orgId: org._id, type: 'test.ok', payload: { n: 'low' } });
    await sched.enqueue({ orgId: org._id, type: 'test.ok', payload: { n: 'high' }, priority: 10 });
    expect((await sched.claimNext()).payload.n).toBe('high');
    expect((await sched.claimNext()).payload.n).toBe('low');
    expect(await sched.claimNext()).toBeNull();
  });
});

describe('run', () => {
  it('success → succeeded with TTL; sensitive payload wiped', async () => {
    const j = await sched.enqueue({
      orgId: org._id,
      type: 'test.ok',
      payload: { n: 1 },
      sensitive: true,
    });
    expect(await sched.tick()).toBe(1);
    const done = await get(j._id);
    expect(done.status).toBe('succeeded');
    expect(done.payload).toEqual({});
    expect(done.expireAt).toBeInstanceOf(Date);
    expect(calls).toEqual([1]);
  });

  it('failure → retry with backoff, then dead', async () => {
    const j = await sched.enqueue({ orgId: org._id, type: 'test.fail' });
    await sched.tick();
    let s = await get(j._id);
    expect(s).toMatchObject({ status: 'queued', attempts: 1, lastError: 'boom' });
    expect(s.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    await Job.collection.updateOne({ _id: j._id }, { $set: { runAt: new Date() } });
    await sched.tick();
    s = await get(j._id);
    expect(s).toMatchObject({ status: 'dead', attempts: 2 });
  });

  it('PermanentJobError buries immediately; timeouts fail the job', async () => {
    const a = await sched.enqueue({ orgId: org._id, type: 'test.permanent' });
    const b = await sched.enqueue({ orgId: org._id, type: 'test.slow' });
    await sched.tick();
    expect((await get(a._id)).status).toBe('dead');
    const slow = await get(b._id);
    expect(slow.status).toBe('dead');
    expect(slow.lastError).toMatch(/Timed out/);
  });

  it('dedupeKey allows one live job per key, and frees the key when done', async () => {
    const a = await sched.enqueue({
      orgId: org._id,
      type: 'test.ok',
      payload: { n: 1 },
      dedupeKey: 'k',
    });
    const b = await sched.enqueue({
      orgId: org._id,
      type: 'test.ok',
      payload: { n: 2 },
      dedupeKey: 'k',
    });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    await sched.tick();
    expect(
      await sched.enqueue({ orgId: org._id, type: 'test.ok', payload: { n: 3 }, dedupeKey: 'k' }),
    ).toBeTruthy();
  });

  it('recovers jobs whose worker died', async () => {
    const j = await sched.enqueue({ orgId: org._id, type: 'test.ok', payload: { n: 9 } });
    await sched.claimNext({ workerId: 'crashed' });
    await Job.collection.updateOne(
      { _id: j._id },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    expect(await sched.recoverStale()).toBe(1);
    await sched.tick();
    expect((await get(j._id)).status).toBe('succeeded');
    expect(calls).toEqual([9]);
  });

  it('a stale worker cannot overwrite a job someone else re-claimed', async () => {
    const j = await sched.enqueue({ orgId: org._id, type: 'test.ok', payload: { n: 5 } });
    const mine = await sched.claimNext({ workerId: 'old' });
    await Job.collection.updateOne({ _id: j._id }, { $set: { lockedBy: 'new' } });
    await sched.runJob(mine, { workerId: 'old' });
    expect((await get(j._id)).status).toBe('running'); // untouched
  });

  it('unknown types are rejected at enqueue', async () => {
    await expect(sched.enqueue({ orgId: org._id, type: 'nope' })).rejects.toThrow(
      /Unknown job type/,
    );
  });
});
