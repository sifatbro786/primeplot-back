import { processLeadEvent } from '#modules/meta/meta.service.js';
import { defineJob, PermanentJobError } from '../registry.js';

// Import one Meta lead (queued by the webhook or a manual retry). ~15 min of retries.
defineJob({
  type: 'meta.fetchLead',
  maxAttempts: 6,
  timeoutMs: 60_000,
  async handler({ leadgenId }, { orgId, job, signal }) {
    if (!leadgenId) throw new PermanentJobError('meta.fetchLead without leadgenId');
    return processLeadEvent(orgId, String(leadgenId), { job, signal });
  },
});
