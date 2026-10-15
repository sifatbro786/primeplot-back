import { createHash } from 'node:crypto';
import { getIntegrationConfig } from '#integrations/config.js';

/**
 * SSLCommerz v4 client (ARCHITECTURE §6.5, B5.2). Pure HTTP — no database, no business rules.
 * The flow is driven by modules/payments/payment.service.js:
 *
 *   initSession()      POST gwprocess/v4/api.php            → GatewayPageURL (redirect the client)
 *   validate(valId)    GET  validator/…/validationserverAPI → the ONLY thing we trust
 *   queryByTranId(id)  GET  validator/…/merchantTransIDvalidationAPI → reconcile job
 *
 * Amounts: SSLCommerz speaks decimal taka strings ("12500.00"); we speak integer poisha.
 * Credentials never go to a log; on GET they ride the query string (that is the API) over TLS.
 */
const TIMEOUT_MS = 20_000;

export class GatewayError extends Error {
  constructor(message, { code = 'GATEWAY_ERROR', retryable = true } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function sslczConfig(orgId) {
  const c = getIntegrationConfig(orgId, 'payment');
  const host = c.isLive ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';
  return { ...c, host };
}

/** 1234550 poisha → "12345.50" */
export function toTakaString(poisha) {
  if (!Number.isSafeInteger(poisha) || poisha < 0) throw new RangeError('Invalid amount');
  return `${Math.floor(poisha / 100)}.${String(poisha % 100).padStart(2, '0')}`;
}

/** "12345.5" / "12345.50" / 12345.5 → 1234550 poisha; null when it isn't a plain amount. */
export function parseTaka(v) {
  const s = String(v ?? '').trim();
  const m = /^(\d{1,13})(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(4, '0');
  if (Number(frac.slice(2)) !== 0) return null; // sub-poisha → not ours
  return Number(m[1]) * 100 + Number(frac.slice(0, 2));
}

async function call(url, { method = 'GET', form, signal }) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    throw new GatewayError(
      `SSLCommerz unreachable: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`,
      { code: 'GATEWAY_UNREACHABLE' },
    );
  }
  const text = await res.text().catch(() => '');
  if (res.status >= 500) {
    throw new GatewayError(`SSLCommerz error (HTTP ${res.status})`, { code: 'GATEWAY_DOWN' });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(`SSLCommerz sent an unexpected reply (HTTP ${res.status})`, {
      code: 'GATEWAY_BAD_RESPONSE',
      retryable: res.status < 400,
    });
  }
}

/**
 * Open a payment session.
 * @param {object} p
 * @param {string} p.tranId our unique id (≤ 30 chars)
 * @param {number} p.amount poisha
 * @param {{ success, fail, cancel, ipn }} p.urls
 * @param {{ name, email, phone, address, city, postcode }} p.customer
 * @param {{ name, category }} p.product
 * @param {Record<string,string>} [p.values] value_a … value_d (echoed back)
 * @returns {{ sessionKey, gatewayUrl }}
 */
export async function initSession(
  orgId,
  { tranId, amount, urls, customer, product, values = {}, signal },
) {
  const c = sslczConfig(orgId);
  if (!c.enabled)
    throw new GatewayError('Online payment is not configured', {
      code: 'PAYMENT_DISABLED',
      retryable: false,
    });
  const form = {
    store_id: c.storeId,
    store_passwd: c.storePass,
    total_amount: toTakaString(amount),
    currency: 'BDT',
    tran_id: tranId,
    success_url: urls.success,
    fail_url: urls.fail,
    cancel_url: urls.cancel,
    ipn_url: urls.ipn,
    cus_name: customer.name.slice(0, 50),
    cus_email: customer.email,
    cus_add1: (customer.address || 'N/A').slice(0, 50),
    cus_city: (customer.city || 'Dhaka').slice(0, 50),
    cus_postcode: customer.postcode || '1000',
    cus_country: 'Bangladesh',
    cus_phone: customer.phone,
    shipping_method: 'NO',
    num_of_item: '1',
    product_name: product.name.slice(0, 255),
    product_category: product.category ?? 'Real Estate',
    product_profile: 'non-physical-goods',
    ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).slice(0, 255)])),
  };
  const body = await call(`${c.host}/gwprocess/v4/api.php`, { method: 'POST', form, signal });
  if (body?.status !== 'SUCCESS' || !body.GatewayPageURL) {
    throw new GatewayError(
      `SSLCommerz refused the session: ${body?.failedreason ?? 'unknown reason'}`,
      {
        code: 'GATEWAY_REFUSED',
        retryable: false,
      },
    );
  }
  return { sessionKey: body.sessionkey ?? null, gatewayUrl: body.GatewayPageURL };
}

/**
 * Order Validation API — the source of truth for a payment. Returns the parsed reply:
 *   { status: 'VALID'|'VALIDATED'|'INVALID_TRANSACTION'|…, tranId, valId, amount (poisha|null),
 *     currency, currencyType, currencyAmount (poisha|null), riskLevel, riskTitle, bankTranId,
 *     cardType, cardBrand, cardIssuer, tranDate, raw }
 */
export async function validate(orgId, valId, { signal } = {}) {
  const c = sslczConfig(orgId);
  const qs = new URLSearchParams({
    val_id: valId,
    store_id: c.storeId,
    store_passwd: c.storePass,
    format: 'json',
  });
  const b = await call(`${c.host}/validator/api/validationserverAPI.php?${qs}`, { signal });
  return normalizeTxn(b);
}

/** Transaction Query by tran_id (reconcile): every attempt SSLCommerz knows for our id. */
export async function queryByTranId(orgId, tranId, { signal } = {}) {
  const c = sslczConfig(orgId);
  const qs = new URLSearchParams({
    tran_id: tranId,
    store_id: c.storeId,
    store_passwd: c.storePass,
    format: 'json',
  });
  const b = await call(`${c.host}/validator/api/merchantTransIDvalidationAPI.php?${qs}`, {
    signal,
  });
  if (b?.APIConnect && b.APIConnect !== 'DONE') {
    throw new GatewayError(`SSLCommerz query failed: ${b.APIConnect}`, {
      code: b.APIConnect === 'INVALID_REQUEST' ? 'GATEWAY_REFUSED' : 'GATEWAY_ERROR',
      retryable: b.APIConnect !== 'INVALID_REQUEST',
    });
  }
  return (Array.isArray(b?.element) ? b.element : []).map(normalizeTxn);
}

export function normalizeTxn(b) {
  return {
    status: String(b?.status ?? '').toUpperCase(),
    tranId: b?.tran_id ?? null,
    valId: b?.val_id ?? null,
    amount: parseTaka(b?.amount),
    currency: b?.currency ?? null,
    currencyType: b?.currency_type ?? null,
    currencyAmount: parseTaka(b?.currency_amount),
    riskLevel: b?.risk_level != null ? Number(b.risk_level) : null,
    riskTitle: b?.risk_title ?? null,
    bankTranId: b?.bank_tran_id ?? null,
    cardType: b?.card_type ?? null,
    cardBrand: b?.card_brand ?? null,
    cardIssuer: b?.card_issuer ?? null,
    tranDate: b?.tran_date ?? null,
  };
}

/**
 * IPN / callback signature check (verify_sign over the fields named in verify_key, with the
 * MD5 of the store password). A hint only — we always confirm with validate() before acting —
 * but a mismatch is logged as a possible forgery.
 */
export function verifySignature(orgId, body) {
  const { storePass } = sslczConfig(orgId);
  if (!body?.verify_sign || !body?.verify_key || !storePass) return false;
  const keys = String(body.verify_key).split(',').filter(Boolean);
  const data = Object.fromEntries(keys.map((k) => [k, body[k] ?? '']));
  data.store_passwd = createHash('md5').update(storePass).digest('hex');
  const str = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('&');
  return createHash('md5').update(str).digest('hex') === String(body.verify_sign);
}
