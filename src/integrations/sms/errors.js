/**
 * A failed send. `permanent` = retrying cannot help (bad number, bad credentials, no balance,
 * unapproved sender ID); otherwise the job retries with backoff. `code` is stable for the UI.
 */
export class SmsSendError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', permanent = false, providerCode = null } = {}) {
    super(message);
    this.name = 'SmsSendError';
    this.code = code;
    this.permanent = permanent;
    this.providerCode = providerCode;
  }
}
