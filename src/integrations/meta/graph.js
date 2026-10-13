import { createHmac } from 'node:crypto';
import { getIntegrationConfig } from '#integrations/config.js';
import { safeEqual } from '#shared/crypto/secrets.js';

/**
 * Minimal Meta Graph API client for Lead Ads (B3.2). Tokens go in the Authorization header,
 * never the URL, and every call carries `appsecret_proof` (works whether or not the app has
 * "Require app secret" switched on).
 */
const BASE = 'https://graph.facebook.com';
const TIMEOUT_MS = 20_000;

/** Fields we read from a lead. If Meta ever drops one, we fall back to the core set. */
export const LEAD_FIELDS =
  'id,created_time,form_id,ad_id,ad_name,adset_name,campaign_name,platform,is_organic,field_data';
const LEAD_FIELDS_CORE = 'id,created_time,form_id,ad_id,field_data';

// Graph error codes → what we do about them.
const AUTH_CODES = new Set([102, 190]); // token expired / revoked / password changed
const PERMISSION_CODES = new Set([10, 200, 210, 230, 299]); // missing permission / not page admin
const RATE_CODES = new Set([4, 17, 32, 613, 80001]);

export class MetaGraphError extends Error {
  constructor(message, { status = null, code = null, subcode = null, fbtraceId = null } = {}) {
    super(message);
    this.name = 'MetaGraphError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.fbtraceId = fbtraceId;
    this.isAuth =
      AUTH_CODES.has(code) || (code >= 200 && code <= 299) || PERMISSION_CODES.has(code);
    this.retryable =
      status == null || status >= 500 || RATE_CODES.has(code) || code === 1 || code === 2;
    this.permanent = !this.retryable;
  }

  /** Short stable code for our API/UI. */
  get kind() {
    if (this.isAuth) return 'META_TOKEN_INVALID';
    if (RATE_CODES.has(this.code)) return 'META_RATE_LIMITED';
    if (this.status == null) return 'META_UNREACHABLE';
    return 'META_GRAPH_ERROR';
  }
}

export function appSecretProof(token, appSecret) {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}

/**
 * One Graph call. `params` go in the query string (or the form body for POST/DELETE).
 * @returns parsed JSON — throws MetaGraphError
 */
export async function graph(method, path, { token, params = {}, signal } = {}) {
  const cfg = getIntegrationConfig(null, 'meta');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (cfg.appSecret) qs.set('appsecret_proof', appSecretProof(token, cfg.appSecret));
  const url = `${BASE}/${cfg.graphVersion}/${String(path).replace(/^\/+/, '')}`;

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const inBody = method === 'POST';
  let res;
  try {
    res = await fetch(inBody ? url : `${url}?${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(inBody && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: inBody ? qs.toString() : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    throw new MetaGraphError(
      `Meta unreachable: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`,
    );
  }
  const text = await res.text().catch(() => '');
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new MetaGraphError(`Meta sent an unexpected reply (HTTP ${res.status})`, {
      status: res.status,
    });
  }
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    throw new MetaGraphError(
      e.message ? String(e.message).slice(0, 300) : `Meta error (HTTP ${res.status})`,
      {
        status: res.status,
        code: Number.isFinite(e.code) ? e.code : null,
        subcode: Number.isFinite(e.error_subcode) ? e.error_subcode : null,
        fbtraceId: e.fbtrace_id ?? null,
      },
    );
  }
  return body;
}

// ── Pages & forms ───────────────────────────────────────────────────────────────

/**
 * Check a token against a Page. With a user / system-user token Meta also returns the Page's own
 * token (`access_token`) — that is the one to store. With a Page token it doesn't, and the
 * given token is already the right one.
 * @returns {{ id, name, pageToken }}
 */
export async function resolvePage(pageId, token, { signal } = {}) {
  const page = await graph('GET', pageId, {
    token,
    params: { fields: 'id,name,access_token' },
    signal,
  });
  return { id: String(page.id), name: page.name ?? null, pageToken: page.access_token || token };
}

/** Subscribe our app to the Page's `leadgen` webhook field. */
export async function subscribePage(pageId, pageToken, { signal } = {}) {
  const res = await graph('POST', `${pageId}/subscribed_apps`, {
    token: pageToken,
    params: { subscribed_fields: 'leadgen' },
    signal,
  });
  if (!(res?.success === true || res?.success === 'true')) {
    throw new MetaGraphError('Meta did not confirm the webhook subscription', { status: 200 });
  }
}

export async function unsubscribePage(pageId, pageToken, { signal } = {}) {
  await graph('DELETE', `${pageId}/subscribed_apps`, { token: pageToken, signal });
}

/** Lead forms of the Page (newest first by Meta's ordering), up to `max`. */
export async function listForms(pageId, pageToken, { max = 200, signal } = {}) {
  const out = [];
  let after;
  do {
    const res = await graph('GET', `${pageId}/leadgen_forms`, {
      token: pageToken,
      params: { fields: 'id,name,status,locale,created_time', limit: '100', after },
      signal,
    });
    for (const f of res.data ?? []) {
      out.push({
        id: String(f.id),
        name: f.name ?? null,
        status: f.status ?? null,
        locale: f.locale ?? null,
        createdTime: f.created_time ?? null,
      });
    }
    after = res.paging?.next ? res.paging?.cursors?.after : undefined;
  } while (after && out.length < max);
  return out.slice(0, max);
}

// ── Leads ───────────────────────────────────────────────────────────────────────

const isMissingField = (err) =>
  err instanceof MetaGraphError && err.code === 100 && /field/i.test(err.message);

/** One lead by its leadgen id. */
export async function getLead(leadgenId, pageToken, { signal } = {}) {
  try {
    return await graph('GET', leadgenId, {
      token: pageToken,
      params: { fields: LEAD_FIELDS },
      signal,
    });
  } catch (err) {
    if (!isMissingField(err)) throw err;
    return graph('GET', leadgenId, {
      token: pageToken,
      params: { fields: LEAD_FIELDS_CORE },
      signal,
    });
  }
}

/**
 * Leads of a form created after `since` (Date), page by page (100 each, at most `maxPages`).
 * Yields arrays of raw leads.
 */
export async function* formLeadsSince(formId, pageToken, since, { maxPages = 10, signal } = {}) {
  let fields = LEAD_FIELDS;
  let after;
  for (let page = 0; page < maxPages; page += 1) {
    let res;
    try {
      res = await graph('GET', `${formId}/leads`, {
        token: pageToken,
        params: {
          fields,
          limit: '100',
          after,
          filtering: [
            {
              field: 'time_created',
              operator: 'GREATER_THAN',
              value: Math.floor(since.getTime() / 1000),
            },
          ],
        },
        signal,
      });
    } catch (err) {
      if (fields !== LEAD_FIELDS_CORE && isMissingField(err)) {
        fields = LEAD_FIELDS_CORE;
        page -= 1;
        continue;
      }
      throw err;
    }
    yield res.data ?? [];
    after = res.paging?.next ? res.paging?.cursors?.after : undefined;
    if (!after) return;
  }
}

// ── Webhook ─────────────────────────────────────────────────────────────────────

/** X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256(app secret, raw request body). */
export function verifyWebhookSignature(rawBody, header, appSecret) {
  if (!rawBody || typeof header !== 'string' || !header.startsWith('sha256=') || !appSecret)
    return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return safeEqual(header.toLowerCase(), expected);
}

/** leadgen changes from a webhook body → [{ leadgenId, pageId, formId, adId, createdTime }]. */
export function leadgenChanges(body) {
  if (body?.object !== 'page' || !Array.isArray(body.entry)) return [];
  const out = [];
  for (const entry of body.entry) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value;
      if (ch?.field !== 'leadgen' || !v?.leadgen_id) continue;
      const id = String(v.leadgen_id);
      if (!/^\d{1,30}$/.test(id)) continue;
      out.push({
        leadgenId: id,
        pageId: String(v.page_id ?? entry.id ?? ''),
        formId: v.form_id != null ? String(v.form_id) : null,
        adId: v.ad_id != null ? String(v.ad_id) : null,
        createdTime: Number.isFinite(v.created_time) ? new Date(v.created_time * 1000) : null,
      });
    }
  }
  return out;
}
