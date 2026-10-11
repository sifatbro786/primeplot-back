/**
 * Job type registry. Handlers register themselves from src/jobs/handlers/*.js (loaded by
 * src/jobs/index.js). A handler receives (payload, ctx) where
 * ctx = { orgId, job, signal, log }, and must be idempotent: a job can run more than once
 * (retry after a crash between "work done" and "marked succeeded").
 *
 * Throw `new PermanentJobError(msg)` for failures that retrying cannot fix.
 */
const handlers = new Map();

export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentJobError';
    this.permanent = true;
  }
}

/**
 * @param {object} def
 * @param {string} def.type
 * @param {(payload: any, ctx: any) => Promise<any>} def.handler
 * @param {number} [def.timeoutMs=60000]
 * @param {number} [def.maxAttempts=5]
 * @param {number} [def.everyMs]  recurring: one instance per org, re-queued after each run
 */
export function defineJob({ type, handler, timeoutMs = 60_000, maxAttempts = 5, everyMs }) {
  if (handlers.has(type)) throw new Error(`Job type already registered: ${type}`);
  handlers.set(type, Object.freeze({ type, handler, timeoutMs, maxAttempts, everyMs }));
}

export function getJobDef(type) {
  return handlers.get(type);
}

export function recurringJobs() {
  return [...handlers.values()].filter((d) => d.everyMs);
}
