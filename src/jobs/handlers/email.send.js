import { sendEmail } from '#integrations/email/index.js';
import { EMAIL_TEMPLATES, renderEmail } from '#integrations/email/templates.js';
import { defineJob, PermanentJobError } from '../registry.js';

defineJob({
  type: 'email.send',
  maxAttempts: 6, // ~30 min of retries covers a typical SMTP hiccup
  timeoutMs: 45_000,
  async handler({ to, template, locale, data }, { orgId }) {
    if (!to || !EMAIL_TEMPLATES.includes(template)) {
      throw new PermanentJobError(`Invalid email job (template=${template})`);
    }
    const msg = renderEmail(template, locale, data ?? {});
    return sendEmail(orgId, { to, ...msg });
  },
});
