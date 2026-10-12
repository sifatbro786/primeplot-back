import { expireHolds } from '#modules/units/unit.service.js';
import { defineJob } from '../registry.js';

// Holds also expire lazily on every read; this job makes the DB (and live grids) catch up.
defineJob({
  type: 'units.expireHolds',
  everyMs: 60_000, // per org
  timeoutMs: 2 * 60_000,
  maxAttempts: 3,
  handler: (_payload, { orgId }) => expireHolds(orgId),
});
