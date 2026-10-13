import { reconcile } from '#modules/meta/meta.service.js';
import { defineJob } from '../registry.js';

// Checks hourly; actually re-reads Meta once a night (02:00–06:00 Dhaka) or when forced
// ("Sync now", right after connecting). No connected Page → nothing to do.
defineJob({
  type: 'meta.reconcile',
  everyMs: 3_600_000, // per org
  timeoutMs: 10 * 60_000,
  maxAttempts: 2,
  handler: ({ force = false } = {}, { orgId, signal }) => reconcile(orgId, { force, signal }),
});
