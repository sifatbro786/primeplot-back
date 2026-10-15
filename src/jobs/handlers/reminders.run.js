import { runReminders } from '#modules/reminders/reminder.service.js';
import { defineJob } from '../registry.js';

// B5.3: installment reminders. Ticks every 30 min; acts only after the send hour (settings) and
// the delivery log keeps every reminder to once per booking/rule/due date.
defineJob({
  type: 'reminders.run',
  everyMs: 30 * 60_000, // per org
  timeoutMs: 5 * 60_000,
  maxAttempts: 2,
  handler: (_payload, { orgId }) => runReminders(orgId),
});
