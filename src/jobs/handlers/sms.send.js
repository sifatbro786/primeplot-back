import { deliverSms } from '#modules/sms/sms.service.js';
import { defineJob, PermanentJobError } from '../registry.js';

defineJob({
  type: 'sms.send',
  maxAttempts: 4, // ~3.5 min of retries; an auto-reply later than that is not worth sending
  timeoutMs: 30_000,
  async handler({ messageId }, { orgId, job, signal }) {
    if (!messageId) throw new PermanentJobError('sms.send without messageId');
    return deliverSms(orgId, messageId, { job, signal });
  },
});
