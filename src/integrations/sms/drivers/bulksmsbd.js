import { SmsSendError } from '../errors.js';
import { postToProvider } from './http.js';

/**
 * BulkSMSBD (bulksmsbd.net). POST <base>/smsapi (form): api_key, senderid, number, message.
 * Reply: { response_code, success_message | error_message }; 202 = accepted.
 * Bangla is sent as Unicode by the gateway automatically.
 */
const DEFAULT_BASE = 'https://bulksmsbd.net/api';

// Codes where trying again later can work; every other non-202 code is a setup/number problem.
const RETRYABLE = new Set(['1005']);
const CODES = {
  1001: ['INVALID_NUMBER', 'Invalid number'],
  1002: ['SENDER_ID_INVALID', 'Sender ID is wrong or disabled'],
  1003: ['PROVIDER_REJECTED', 'Required fields missing'],
  1005: ['PROVIDER_DOWN', 'Internal error at the provider'],
  1006: ['BALANCE_EXPIRED', 'Balance validity not available'],
  1007: ['INSUFFICIENT_BALANCE', 'Insufficient balance'],
  1011: ['AUTH_FAILED', 'User not found'],
  1012: ['MASKING_NEEDS_BANGLA', 'Masking SMS must be in Bangla'],
  1013: ['SENDER_ID_INVALID', 'No gateway for this sender ID and API key'],
  1018: ['AUTH_FAILED', 'Account disabled'],
  1031: ['AUTH_FAILED', 'Account not verified'],
  1032: ['IP_NOT_WHITELISTED', 'Server IP is not whitelisted at the provider'],
};

export async function send({ msisdn, text, config, signal }) {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const { body } = await postToProvider(`${base}/smsapi`, {
    form: { api_key: config.apiKey, senderid: config.senderId, number: msisdn, message: text },
    signal,
  });
  const code = String(body?.response_code ?? '');
  if (code === '202') return { providerMessageId: null };

  const [errCode, fallback] = CODES[code] ?? ['PROVIDER_REJECTED', 'Rejected by the provider'];
  const msg =
    typeof body?.error_message === 'string' && body.error_message ? body.error_message : fallback;
  throw new SmsSendError(`BulkSMSBD ${code || '?'}: ${msg}`, {
    code: errCode,
    permanent: !RETRYABLE.has(code),
    providerCode: code || null,
  });
}
