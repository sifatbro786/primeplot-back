import { sendDueReminders } from '#modules/leads/followup.service.js';
import { defineJob } from '../registry.js';

// Follow-up reminders: notify a task's owner when its reminder time passes (once per task).
defineJob({
  type: 'leads.taskReminders',
  everyMs: 60_000, // per org
  timeoutMs: 2 * 60_000,
  maxAttempts: 3,
  handler: (_payload, { orgId }) => sendDueReminders(orgId),
});
