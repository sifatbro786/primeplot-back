import { escalateSlaBreaches } from '#modules/leads/lead.service.js';
import { defineJob } from '../registry.js';

// First-response SLA missed → tell the managers, once per lead (B3.2).
defineJob({
  type: 'leads.slaEscalation',
  everyMs: 60_000, // per org
  timeoutMs: 2 * 60_000,
  maxAttempts: 3,
  handler: (_payload, { orgId }) => escalateSlaBreaches(orgId),
});
