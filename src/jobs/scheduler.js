import { hostname } from 'node:os';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { randomToken } from '#shared/crypto/secrets.js';
import { listActiveOrgIds } from '#modules/organizations/organization.service.js';
import { Job } from './job.model.js';
import { getJobDef, recurringJobs } from './registry.js';

/**
 * MongoDB-backed job scheduler (ARCHITECTURE §6.3) — no Redis.
 *  - enqueue() inserts a job; due jobs are claimed with one atomic findOneAndUpdate, so two
 *    workers (or two overlapping ticks) can never run the same job.
 *  - Failures retry with exponential backoff + jitter, then go `dead` (kept 30 days).
 *  - A crashed worker's jobs come back after their lock expires.
 *  - Ticks: in-process interval (JOB_TICK_MS) + an immediate nudge when work is enqueued,
 *    + POST /api/v1/internal/cron/tick for ops.
 */
const log = logger.child({ module: 'jobs' });
const WORKER_ID = `${hostname()}:${process.pid}:${randomToken(4)}`;
const DAY = 86_400_000;
const KEEP_SUCCEEDED_MS = 7 * DAY;
const KEEP_DEAD_MS = 30 * DAY;
const MAX_PER_TICK = 50;
const LOCK_SLACK_MS = 30_000;

const SKIP = { skipTenant: true }; // the scheduler works across orgs by design

let interval = null;
let started = false;
let stopping = false;
let current = null; // Promise of the running tick
let rerun = false;

export function backoffMs(attempts) {
  const base = 30_000 * 2 ** Math.max(0, attempts - 1); // 30s, 1m, 2m, 4m, 8m…
  const jitter = Math.random() * 0.2 * base;
  return Math.min(base + jitter, 3_600_000);
}

/**
 * Queue a job.
 * @returns the job doc, or null when `dedupeKey` matched a live job (already queued/running).
 * Inside a transaction pass `{ session }` (no dedupeKey there: a duplicate-key error would
 * abort the whole transaction) and call nudge() after commit.
 */
export async function enqueue({
  orgId,
  type,
  payload = {},
  runAt = new Date(),
  priority = 0,
  dedupeKey,
  sensitive = false,
  session,
}) {
  const def = getJobDef(type);
  if (!def) throw new Error(`Unknown job type: ${type}`);
  if (!orgId) throw new Error('enqueue() requires orgId');
  if (session && dedupeKey) throw new Error('dedupeKey is not supported inside a transaction');

  const doc = {
    orgId,
    type,
    payload,
    runAt,
    priority,
    maxAttempts: def.maxAttempts,
    sensitive,
    ...(dedupeKey && { dedupeKey }),
  };
  try {
    const [job] = await Job.create([doc], session ? { session } : {});
    if (!session && runAt <= new Date()) nudge();
    return job;
  } catch (err) {
    if (err?.code === 11000 && dedupeKey) return null;
    throw err;
  }
}

/** Atomically claim the next due job (or null). Exported for tests. */
export async function claimNext({ workerId = WORKER_ID, now = new Date() } = {}) {
  return Job.findOneAndUpdate(
    { status: 'queued', runAt: { $lte: now } },
    {
      $set: {
        status: 'running',
        lockedBy: workerId,
        startedAt: now,
        // Provisional lock; runJob() extends it to the handler's timeout.
        lockedUntil: new Date(now.getTime() + 5 * 60_000),
      },
      $inc: { attempts: 1 },
    },
    { sort: { priority: -1, runAt: 1 }, returnDocument: 'after', lean: true },
  ).setOptions(SKIP);
}

/** Jobs whose worker died mid-run: requeue, or bury if out of attempts. */
export async function recoverStale(now = new Date()) {
  const stale = { status: 'running', lockedUntil: { $lt: now } };
  const dead = await Job.updateMany(
    { ...stale, $expr: { $gte: ['$attempts', '$maxAttempts'] } },
    {
      $set: {
        status: 'dead',
        lastError: 'Worker lock expired (crash or timeout)',
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
        expireAt: new Date(now.getTime() + KEEP_DEAD_MS),
      },
      $unset: { dedupeKey: 1 },
    },
  ).setOptions(SKIP);
  const requeued = await Job.updateMany(stale, {
    $set: {
      status: 'queued',
      runAt: now,
      lockedBy: null,
      lockedUntil: null,
      lastError: 'Worker lock expired (crash or timeout)',
    },
  }).setOptions(SKIP);
  const n = dead.modifiedCount + requeued.modifiedCount;
  if (n)
    log.warn(
      { dead: dead.modifiedCount, requeued: requeued.modifiedCount },
      'Recovered stale jobs',
    );
  return n;
}

async function scheduleNextRecurring(def, orgId) {
  await enqueue({
    orgId,
    type: def.type,
    runAt: new Date(Date.now() + def.everyMs),
    dedupeKey: `recurring:${def.type}`,
  });
}

/** Run one claimed job to completion (success, retry or dead). Exported for tests. */
export async function runJob(job, { workerId = WORKER_ID } = {}) {
  const def = getJobDef(job.type);
  const mine = { _id: job._id, status: 'running', lockedBy: workerId };
  const jlog = log.child({ jobId: String(job._id), type: job.type, attempt: job.attempts });

  if (!def) {
    await Job.updateOne(mine, {
      $set: {
        status: 'dead',
        lastError: `No handler for ${job.type}`,
        finishedAt: new Date(),
        expireAt: new Date(Date.now() + KEEP_DEAD_MS),
      },
      $unset: { dedupeKey: 1 },
    }).setOptions(SKIP);
    jlog.error('No handler registered — job buried');
    return 'dead';
  }

  await Job.updateOne(mine, {
    $set: { lockedUntil: new Date(Date.now() + def.timeoutMs + LOCK_SLACK_MS) },
  }).setOptions(SKIP);

  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Timed out after ${def.timeoutMs}ms`));
    }, def.timeoutMs);
  });

  const started = Date.now();
  try {
    await Promise.race([
      def.handler(job.payload ?? {}, { orgId: job.orgId, job, signal: ctrl.signal, log: jlog }),
      timeout,
    ]);
    const now = new Date();
    await Job.updateOne(mine, {
      $set: {
        status: 'succeeded',
        finishedAt: now,
        lockedUntil: null,
        lastError: null,
        expireAt: new Date(now.getTime() + KEEP_SUCCEEDED_MS),
        ...(job.sensitive && { payload: {} }),
      },
      $unset: { dedupeKey: 1 },
    }).setOptions(SKIP);
    jlog.info({ ms: Date.now() - started }, 'Job succeeded');
    if (def.everyMs) await scheduleNextRecurring(def, job.orgId);
    return 'succeeded';
  } catch (err) {
    const now = new Date();
    const final = err?.permanent || job.attempts >= job.maxAttempts;
    const message = String(err?.message ?? err).slice(0, 2000);
    await Job.updateOne(
      mine,
      final
        ? {
            $set: {
              status: 'dead',
              lastError: message,
              finishedAt: now,
              lockedBy: null,
              lockedUntil: null,
              expireAt: new Date(now.getTime() + KEEP_DEAD_MS),
              ...(job.sensitive && { payload: {} }),
            },
            $unset: { dedupeKey: 1 },
          }
        : {
            $set: {
              status: 'queued',
              lastError: message,
              runAt: new Date(now.getTime() + backoffMs(job.attempts)),
              lockedBy: null,
              lockedUntil: null,
            },
          },
    ).setOptions(SKIP);
    jlog[final ? 'error' : 'warn'](
      { err: { message }, final },
      final ? 'Job failed permanently' : 'Job failed — will retry',
    );
    if (final && def.everyMs) await scheduleNextRecurring(def, job.orgId);
    return final ? 'dead' : 'retry';
  } finally {
    clearTimeout(timer);
  }
}

async function lane(budget) {
  let n = 0;
  while (!stopping && budget.left > 0) {
    budget.left--;
    const job = await claimNext();
    if (!job) break;
    await runJob(job);
    n++;
  }
  return n;
}

async function doTick() {
  await recoverStale();
  const budget = { left: MAX_PER_TICK };
  const counts = await Promise.all(Array.from({ length: env.JOB_CONCURRENCY }, () => lane(budget)));
  return counts.reduce((a, b) => a + b, 0);
}

/** Process due jobs now. Overlapping calls share the running tick. Returns jobs processed. */
export async function tick() {
  if (current) {
    rerun = true;
    return 0;
  }
  let processed = 0;
  current = (async () => {
    do {
      rerun = false;
      try {
        processed += await doTick();
      } catch (err) {
        log.error({ err }, 'Scheduler tick failed');
        break;
      }
    } while (rerun && !stopping);
    return processed;
  })();
  try {
    return await current;
  } finally {
    current = null;
  }
}

let nudgeTimer = null;
/** Ask for a tick soon (debounced). No-op unless the scheduler is started. */
export function nudge() {
  if (!started || stopping || nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    tick();
  }, 50);
  nudgeTimer.unref();
}

/** Make sure every recurring job has one live instance per org. */
export async function ensureRecurring() {
  const defs = recurringJobs();
  if (!defs.length) return;
  for (const orgId of await listActiveOrgIds()) {
    for (const def of defs) {
      await enqueue({
        orgId,
        type: def.type,
        runAt: new Date(Date.now() + 60_000),
        dedupeKey: `recurring:${def.type}`,
      });
    }
  }
}

export async function startScheduler() {
  if (started) return;
  started = true;
  stopping = false;
  await ensureRecurring();
  interval = setInterval(() => tick(), env.JOB_TICK_MS);
  interval.unref();
  log.info(
    { workerId: WORKER_ID, everyMs: env.JOB_TICK_MS, concurrency: env.JOB_CONCURRENCY },
    'Job scheduler started',
  );
  nudge();
}

/** Stop claiming new jobs and wait for the in-flight tick (server shutdown has its own timeout). */
export async function stopScheduler() {
  if (!started) return;
  stopping = true;
  clearInterval(interval);
  clearTimeout(nudgeTimer);
  nudgeTimer = null;
  if (current) await current.catch(() => {});
  started = false;
  log.info('Job scheduler stopped');
}

export function schedulerStatus() {
  return { started, workerId: WORKER_ID, busy: Boolean(current) };
}
