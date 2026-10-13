import { SmsSendError } from '../errors.js';
import { postToProvider } from './http.js';

/**
 * SSL Wireless SMS Plus, API v3. POST <base>/api/v3/send-sms (JSON):
 *   { api_token, sid, msisdn, sms, csms_id }  — csms_id is our unique id per message (≤ 20 chars),
 *   so a retried request cannot be billed twice.
 * Reply: { status: "SUCCESS"|"FAILED", status_code, error_message,
 *          smsinfo: [{ sms_status, status_message, msisdn, csms_id, reference_id }] }
 */
const DEFAULT_BASE = 'https://smsplus.sslwireless.com';
const AUTH_CODES = new Set([4001, 4022]);

export async function send({ msisdn, text, clientRef, config, signal }) {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const { body } = await postToProvider(`${base}/api/v3/send-sms`, {
    json: { api_token: config.apiKey, sid: config.senderId, msisdn, sms: text, csms_id: clientRef },
    signal,
  });
  const info = Array.isArray(body?.smsinfo) ? body.smsinfo[0] : null;
  if (body?.status === 'SUCCESS' && (!info || info.sms_status === 'SUCCESS')) {
    return { providerMessageId: info?.reference_id != null ? String(info.reference_id) : null };
  }

  const statusCode = Number(body?.status_code);
  const msg = info?.status_message || body?.error_message || 'Rejected by the provider';
  // A repeat of a csms_id we already sent means the first attempt went through.
  if (/duplicate/i.test(msg) && /csms/i.test(msg))
    return { providerMessageId: null, duplicate: true };
  throw new SmsSendError(`SSL Wireless ${Number.isFinite(statusCode) ? statusCode : '?'}: ${msg}`, {
    code: AUTH_CODES.has(statusCode)
      ? 'AUTH_FAILED'
      : /balance/i.test(msg)
        ? 'INSUFFICIENT_BALANCE'
        : /msisdn|number/i.test(msg)
          ? 'INVALID_NUMBER'
          : 'PROVIDER_REJECTED',
    permanent: true,
    providerCode: Number.isFinite(statusCode) ? String(statusCode) : null,
  });
}
