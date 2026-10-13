import { randomToken } from '#shared/crypto/secrets.js';
import { logger } from '#config/logger.js';

const log = logger.child({ module: 'sms', driver: 'log' });

/** Development driver: nothing leaves the server; the message is written to the API log. */
export async function send({ msisdn, text }) {
  log.info({ to: msisdn, text }, 'SMS (log driver — not sent)');
  return { providerMessageId: `log-${randomToken(6)}` };
}
