import { getIntegrationConfig } from '#integrations/config.js';
import * as bulksmsbd from './drivers/bulksmsbd.js';
import * as logDriver from './drivers/log.js';
import * as sslwireless from './drivers/sslwireless.js';
import { SmsSendError } from './errors.js';

export { SmsSendError } from './errors.js';
export { analyzeSms, smsCost, LIMITS } from './segments.js';

const DRIVERS = { log: logDriver, bulksmsbd, sslwireless };

/**
 * Bangladesh gateways deliver to BD mobiles only: +8801XXXXXXXXX → "8801XXXXXXXXX".
 * Returns null for anything else (e.g. an NRB buyer's foreign number).
 */
export function toBdMsisdn(e164) {
  const m = /^\+(8801[3-9]\d{8})$/.exec(e164 ?? '');
  return m ? m[1] : null;
}

/** Driver in use + whether messages really leave the server (log = no). Never returns keys. */
export function smsInfo(orgId) {
  const c = getIntegrationConfig(orgId, 'sms');
  return {
    driver: c.driver,
    live: c.enabled,
    senderId: c.enabled ? (c.senderId ?? null) : null,
    costPerSegmentPoisha: c.costPerSegmentPoisha,
  };
}

/**
 * Send one SMS now (callers normally go through the `sms.send` job, which retries).
 * @param {{ to: string, text: string, clientRef: string, signal?: AbortSignal }} msg
 *   to = E.164; clientRef = our unique message id (providers that support it dedupe on it).
 * @returns {{ driver, providerMessageId }}  — throws SmsSendError
 */
export async function sendSms(orgId, { to, text, clientRef, signal }) {
  const config = getIntegrationConfig(orgId, 'sms');
  const driver = DRIVERS[config.driver];
  if (!driver) throw new SmsSendError(`Unknown SMS driver ${config.driver}`, { permanent: true });
  const msisdn = toBdMsisdn(to);
  if (!msisdn) {
    throw new SmsSendError('Only Bangladesh mobile numbers can receive SMS', {
      code: 'UNSUPPORTED_DESTINATION',
      permanent: true,
    });
  }
  const res = await driver.send({ msisdn, text, clientRef, config, signal });
  return { driver: config.driver, providerMessageId: res.providerMessageId ?? null };
}
