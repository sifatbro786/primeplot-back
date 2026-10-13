import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import { Notification } from '#modules/notifications/notification.model.js';
import { notify } from '#modules/notifications/notification.service.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';

const log = logger.child({ module: 'integration-alerts' });
const QUIET_MS = 6 * 3_600_000;

/**
 * Tell the people who manage integrations (admins) that one is broken — expired Meta token,
 * wrong SMS key, no SMS balance. At most one alert per integration + code every 6 hours, so a
 * burst of failing sends doesn't flood the bell. Best-effort.
 */
export async function alertIntegrationError(orgId, integration, { code, message }) {
  try {
    const recent = await Notification.exists({
      orgId,
      type: 'integration.error',
      'data.integration': integration,
      'data.code': code,
      createdAt: { $gte: new Date(Date.now() - QUIET_MS) },
    });
    if (recent) return;
    const admins = (await listActiveStaffWith(orgId, P.SETTINGS_INTEGRATIONS)).map((u) => u.id);
    await notify(orgId, admins, 'integration.error', {
      integration,
      code,
      message: String(message ?? '').slice(0, 300),
    });
  } catch (err) {
    log.error(
      { err: { message: err.message }, integration, code },
      'Failed to raise integration alert',
    );
  }
}
