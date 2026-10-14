import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { enqueue } from '#jobs/scheduler.js';

/**
 * On-demand revalidation of the public site (ARCHITECTURE §7): the Next.js app caches public
 * pages by tag; when inventory changes, the API calls the frontend's /api/revalidate.
 *
 * Request (frontend contract, docs/API.md):
 *   POST <FRONTEND_REVALIDATE_URL>   { "tags": ["projects", "project:<slug>"] }
 *   X-PrimePlot-Timestamp: <unix seconds>
 *   X-PrimePlot-Signature: sha256=<hex HMAC-SHA256(REVALIDATE_SECRET, `${timestamp}.${rawBody}`)>
 * The frontend must verify the signature in constant time and reject timestamps older than
 * 5 minutes (replay).
 *
 * Calls go through the job queue: retried on failure, and bursts (e.g. 40 units edited in a
 * minute) coalesce into one call per tag set via dedupeKey + a short delay.
 */
const log = logger.child({ module: 'revalidate' });
const COALESCE_MS = 3_000;

export const projectTags = (slug) => ['projects', `project:${slug}`];

export function signRevalidation(body, timestamp, secret = env.REVALIDATE_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const MAX_SKEW_SEC = 300;

/**
 * Check a server-to-server request signed by the website with the same shared secret
 * (used for draft previews: `X-PrimePlot-Timestamp` + `X-PrimePlot-Signature` over
 * `"<timestamp>.<payload>"`). Constant time; stale timestamps (> 5 min) are refused.
 */
export function verifySiteSignature(payload, timestamp, signature, secret = env.REVALIDATE_SECRET) {
  if (!secret || !/^\d{9,12}$/.test(String(timestamp ?? ''))) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_SKEW_SEC) return false;
  const expected = Buffer.from(signRevalidation(payload, timestamp, secret));
  const given = Buffer.from(String(signature ?? ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Fire-and-forget from services (never fails the caller). */
export async function queueRevalidate(orgId, tags) {
  if (!env.features.revalidate || !tags?.length) return;
  const unique = [...new Set(tags)].sort();
  try {
    await enqueue({
      orgId,
      type: 'frontend.revalidate',
      payload: { tags: unique },
      runAt: new Date(Date.now() + COALESCE_MS),
      dedupeKey: `revalidate:${unique.join('|')}`.slice(0, 500),
    });
  } catch (err) {
    log.warn({ err: { message: err.message }, tags: unique }, 'Could not queue revalidation');
  }
}

/** Used by the job handler. Throws on non-2xx so the scheduler retries. */
export async function sendRevalidation(tags, { signal } = {}) {
  if (!env.features.revalidate) return { skipped: true };
  const body = JSON.stringify({ tags });
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(env.revalidateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PrimePlot-Timestamp': String(ts),
      'X-PrimePlot-Signature': signRevalidation(body, ts),
    },
    body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Revalidate responded ${res.status}`);
  return { status: res.status, tags };
}
