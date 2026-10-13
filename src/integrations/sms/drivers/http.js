import { SmsSendError } from '../errors.js';

const TIMEOUT_MS = 15_000;

/**
 * POST to a provider and parse JSON. Network errors, timeouts and HTTP 5xx are retryable;
 * a 4xx or a non-JSON body is permanent (the request itself is wrong).
 * Credentials travel in the body, never in the URL, so they stay out of proxy/access logs.
 */
export async function postToProvider(url, { json, form, signal }) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      },
      body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    throw new SmsSendError(
      `SMS provider unreachable: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`,
      {
        code: 'PROVIDER_UNREACHABLE',
      },
    );
  }
  const text = await res.text().catch(() => '');
  if (res.status >= 500) {
    throw new SmsSendError(`SMS provider error (HTTP ${res.status})`, { code: 'PROVIDER_DOWN' });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SmsSendError(`SMS provider sent an unexpected reply (HTTP ${res.status})`, {
      code: 'PROVIDER_BAD_RESPONSE',
      permanent: res.status >= 400,
    });
  }
  return { status: res.status, body };
}
