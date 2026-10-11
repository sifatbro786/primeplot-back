import { enqueue } from '#jobs/scheduler.js';

/**
 * Queue a templated email (sent by the `email.send` job, with retries).
 * Set `sensitive: true` when `data` contains a secret link — the payload is wiped after sending.
 */
export function queueEmail({
  orgId,
  to,
  template,
  locale = 'bn',
  data,
  sensitive = false,
  session,
}) {
  return enqueue({
    orgId,
    type: 'email.send',
    payload: { to, template, locale, data },
    priority: sensitive ? 10 : 0, // auth links first
    sensitive,
    session,
  });
}
