import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { getIntegrationConfig } from '#integrations/config.js';
import {
  formLeadsSince,
  getLead,
  leadgenChanges,
  listForms,
  MetaGraphError,
  resolvePage,
  subscribePage,
  unsubscribePage,
} from '#integrations/meta/graph.js';
import { mapMetaLead, parseMetaTime } from '#integrations/meta/leadFields.js';
import { enqueue } from '#jobs/scheduler.js';
import { PermanentJobError } from '#jobs/registry.js';
import { decryptSecret, encryptSecret } from '#shared/crypto/secrets.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '#shared/errors/AppError.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { normalizePhone } from '#shared/utils/phone.js';
import { audit } from '#modules/audit/audit.service.js';
import { alertIntegrationError } from '#modules/integrations/alerts.js';
import { sendAutoReply } from '#modules/leads/autoReply.js';
import { Lead } from '#modules/leads/lead.model.js';
import { intakeLead } from '#modules/leads/lead.service.js';
import { LeadActivity } from '#modules/leads/leadActivity.model.js';
import { getProjectAccess } from '#modules/projects/project.service.js';
import { MetaConnection } from './metaConnection.model.js';
import { MetaLeadEvent } from './metaLeadEvent.model.js';

/**
 * Meta Lead Ads (B3.2, ARCHITECTURE §6.5).
 *   webhook → MetaLeadEvent (idempotent on leadgen id) → job `meta.fetchLead` → Graph API →
 *   intakeLead() (same dedupe/round-robin/SLA as the website form) → auto-reply SMS.
 *   Job `meta.reconcile` re-reads the last 48 hours of every form once a night (or on demand),
 *   so a lead whose webhook was lost still arrives.
 */
const log = logger.child({ module: 'meta' });
const { ObjectId } = mongoose.Types;
const TOKEN_PURPOSE = 'meta-page-token';
const HOUR = 3_600_000;
const LOCK_MS = 5 * 60_000;
const RECONCILE_HOURS = 48;
const SKIP = { skipTenant: true }; // webhook: the org is found from the page id

const staleVersion = () =>
  new ConflictError('This record was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

function requireConfigured() {
  if (!getIntegrationConfig(null, 'meta').enabled) {
    throw new AppError(
      'Meta Lead Ads is not set up on the server (META_APP_SECRET / META_VERIFY_TOKEN)',
      {
        statusCode: 409,
        code: 'META_NOT_CONFIGURED',
      },
    );
  }
}

/** A Graph failure during a staff action → a 400 the dashboard can show as is. */
function graphToBadRequest(err, fallbackCode) {
  if (!(err instanceof MetaGraphError)) return err;
  return new BadRequestError(err.message, {
    code: err.kind === 'META_TOKEN_INVALID' ? 'META_TOKEN_INVALID' : fallbackCode,
    details: [{ path: 'meta', message: err.message, code: err.code, fbtraceId: err.fbtraceId }],
  });
}

// ── Connection ──────────────────────────────────────────────────────────────────

export function toConnection(c) {
  if (!c) return null;
  return {
    version: c.__v ?? 0,
    pageId: c.pageId,
    pageName: c.pageName ?? null,
    tokenHint: c.tokenHint ?? null,
    status: c.status,
    lastError: c.lastError?.code
      ? { code: c.lastError.code, message: c.lastError.message ?? null, at: c.lastError.at ?? null }
      : null,
    formMappings: (c.formMappings ?? []).map((m) => ({
      formId: m.formId,
      formName: m.formName ?? null,
      type: m.type,
      projectId: m.projectId ? String(m.projectId) : null,
    })),
    connectedAt: c.connectedAt ?? null,
    lastLeadAt: c.lastLeadAt ?? null,
    lastReconciledAt: c.lastReconciledAt ?? null,
    lastReconcile: c.lastReconcile ?? null,
  };
}

async function loadConnection(orgId, { withToken = false } = {}) {
  const q = MetaConnection.findOne({ orgId });
  if (withToken) q.select('+tokenEnc');
  const c = await q.lean();
  if (!c) return null;
  if (withToken) c.token = decryptSecret(c.tokenEnc, TOKEN_PURPOSE);
  delete c.tokenEnc;
  return c;
}

/** Token stopped working → mark the connection and tell the admins (throttled). */
async function markConnectionError(orgId, err) {
  const code = err instanceof MetaGraphError ? err.kind : 'META_ERROR';
  const message = String(err?.message ?? err).slice(0, 300);
  await MetaConnection.updateOne(
    { orgId },
    { $set: { status: 'error', lastError: { code, message, at: new Date() } } },
  );
  await alertIntegrationError(orgId, 'meta', { code, message });
}

async function markConnectionHealthy(orgId) {
  await MetaConnection.updateOne(
    { orgId, status: 'error' },
    { $set: { status: 'active', lastError: { code: null, message: null, at: null } } },
  );
}

/** Settings view: server setup, the connected Page and the last 7 days of imports. */
export async function metaStatus(orgId) {
  const cfg = getIntegrationConfig(orgId, 'meta');
  const conn = await loadConnection(orgId);
  const since = new Date(Date.now() - 7 * 24 * HOUR);
  const rows = await MetaLeadEvent.aggregate([
    { $match: { orgId: new ObjectId(String(orgId)), createdAt: { $gte: since } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return {
    configured: cfg.enabled,
    graphVersion: cfg.graphVersion,
    webhookPath: '/api/v1/webhooks/meta',
    connection: toConnection(conn),
    last7Days: Object.fromEntries(rows.map((r) => [r._id, r.count])),
  };
}

/**
 * Connect (or replace) the Page. `accessToken` may be a Page token or a user / system-user
 * token with access to the Page — we then store the Page token Meta derives from it.
 * The app is subscribed to the Page's `leadgen` field right away.
 */
export async function connectPage({ orgId, user, pageId, accessToken, ctx }) {
  requireConfigured();
  let page;
  try {
    page = await resolvePage(pageId, accessToken);
  } catch (err) {
    throw graphToBadRequest(err, 'META_PAGE_NOT_FOUND');
  }
  if (page.id !== pageId) {
    throw new BadRequestError('That token belongs to a different Page', {
      code: 'META_PAGE_MISMATCH',
    });
  }
  const taken = await MetaConnection.findOne({ pageId, orgId: { $ne: orgId } })
    .setOptions(SKIP)
    .lean();
  if (taken) {
    throw new ConflictError('This Page is already connected to another account', {
      code: 'META_PAGE_TAKEN',
    });
  }
  try {
    await subscribePage(page.id, page.pageToken);
  } catch (err) {
    throw graphToBadRequest(err, 'META_SUBSCRIBE_FAILED');
  }

  const previous = await loadConnection(orgId, { withToken: true });
  if (previous && previous.pageId !== page.id && previous.token) {
    await unsubscribePage(previous.pageId, previous.token).catch((err) =>
      log.warn({ err: { message: err.message } }, 'Could not unsubscribe the previous Page'),
    );
  }
  const samePage = previous?.pageId === page.id;
  await MetaConnection.findOneAndUpdate(
    { orgId },
    {
      $set: {
        pageId: page.id,
        pageName: page.name ? String(page.name).slice(0, 200) : null,
        tokenEnc: encryptSecret(page.pageToken, TOKEN_PURPOSE),
        tokenHint: `…${page.pageToken.slice(-4)}`,
        status: 'active',
        lastError: { code: null, message: null, at: null },
        connectedBy: new ObjectId(user.id),
        connectedAt: new Date(),
        ...(!samePage && { formMappings: [], lastLeadAt: null, lastReconciledAt: null }),
      },
      $inc: { __v: 1 },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
  await audit(ctx, 'integration.meta.connect', {
    entity: { type: 'MetaConnection', id: null },
    meta: {
      pageId: page.id,
      pageName: page.name ?? null,
      replaced: previous ? previous.pageId : null,
    },
  });
  // Pick up anything submitted in the last 48 h straight away.
  await requestSync(orgId);
  return metaStatus(orgId);
}

export async function disconnectPage({ orgId, ctx }) {
  const conn = await loadConnection(orgId, { withToken: true });
  if (!conn) throw new NotFoundError('No Page is connected');
  if (conn.token) {
    await unsubscribePage(conn.pageId, conn.token).catch((err) =>
      log.warn({ err: { message: err.message } }, 'Could not unsubscribe the Page (continuing)'),
    );
  }
  await MetaConnection.deleteOne({ orgId });
  await audit(ctx, 'integration.meta.disconnect', {
    entity: { type: 'MetaConnection', id: null },
    meta: { pageId: conn.pageId, pageName: conn.pageName ?? null },
  });
}

async function connectionOr404(orgId) {
  const conn = await loadConnection(orgId, { withToken: true });
  if (!conn) throw new NotFoundError('No Page is connected');
  if (!conn.token) {
    throw new ConflictError(
      'The stored Page token cannot be read (server secret changed) — connect the Page again',
      {
        code: 'META_TOKEN_UNREADABLE',
      },
    );
  }
  return conn;
}

/** Lead forms on the Page (live from Meta) with our mapping for each. */
export async function listPageForms(orgId) {
  const conn = await connectionOr404(orgId);
  let forms;
  try {
    forms = await listForms(conn.pageId, conn.token);
  } catch (err) {
    if (err instanceof MetaGraphError && err.isAuth) await markConnectionError(orgId, err);
    throw graphToBadRequest(err, 'META_GRAPH_ERROR');
  }
  const byId = new Map((conn.formMappings ?? []).map((m) => [m.formId, m]));
  return forms.map((f) => {
    const m = byId.get(f.id);
    return {
      ...f,
      mapping: m ? { type: m.type, projectId: m.projectId ? String(m.projectId) : null } : null,
    };
  });
}

/** Replace the form → pipeline/project routing. Forms not listed use the buyer pipeline, no project. */
export async function updateFormMappings({ orgId, version, mappings, ctx }) {
  const doc = await MetaConnection.findOne({ orgId });
  if (!doc) throw new NotFoundError('No Page is connected');
  if (doc.__v !== version) throw staleVersion();
  const seen = new Set();
  for (const m of mappings) {
    if (seen.has(m.formId)) {
      throw new BadRequestError('A form appears twice', {
        code: 'DUPLICATE_FORM',
        details: [{ path: 'mappings', message: m.formId }],
      });
    }
    seen.add(m.formId);
    if (m.projectId && !(await getProjectAccess(orgId, m.projectId))) {
      throw new BadRequestError('Unknown project', { code: 'UNKNOWN_PROJECT' });
    }
  }
  const before = toConnection(doc.toObject()).formMappings;
  doc.formMappings = mappings.map((m) => ({
    formId: m.formId,
    formName: m.formName ?? null,
    type: m.type,
    projectId: m.projectId ? new ObjectId(m.projectId) : null,
  }));
  await doc.save();
  const after = toConnection(doc.toObject());
  await audit(ctx, 'integration.meta.forms', {
    diff: { formMappings: { from: before, to: after.formMappings } },
  });
  return after;
}

// ── Webhook ─────────────────────────────────────────────────────────────────────

/**
 * Store each new leadgen id and queue its import. Unknown pages are ignored (logged).
 * Safe to call again with the same body (Meta retries): known ids are skipped.
 */
export async function receiveWebhook(body) {
  const changes = leadgenChanges(body);
  if (!changes.length) return { accepted: 0, ignored: 0 };
  const pageIds = [...new Set(changes.map((c) => c.pageId).filter(Boolean))];
  const conns = await MetaConnection.find({ pageId: { $in: pageIds } })
    .select('orgId pageId')
    .setOptions(SKIP)
    .lean();
  const orgByPage = new Map(conns.map((c) => [c.pageId, c.orgId]));

  let accepted = 0;
  let ignored = 0;
  for (const ch of changes) {
    const orgId = orgByPage.get(ch.pageId);
    if (!orgId) {
      ignored += 1;
      log.warn({ pageId: ch.pageId }, 'Meta webhook for a Page that is not connected — ignored');
      continue;
    }
    const res = await MetaLeadEvent.updateOne(
      { orgId, leadgenId: ch.leadgenId },
      {
        $setOnInsert: {
          pageId: ch.pageId,
          formId: ch.formId,
          adId: ch.adId,
          via: 'webhook',
          status: 'received',
          metaCreatedAt: ch.createdTime,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) {
      await enqueue({
        orgId,
        type: 'meta.fetchLead',
        payload: { leadgenId: ch.leadgenId },
        priority: 5,
        dedupeKey: `meta-lead:${ch.leadgenId}`,
      });
      accepted += 1;
    }
  }
  return { accepted, ignored };
}

// ── Import one lead ─────────────────────────────────────────────────────────────

async function finishEvent(orgId, eventId, set) {
  await MetaLeadEvent.updateOne(
    { orgId, _id: eventId },
    { $set: { ...set, lockedUntil: null, processedAt: new Date() } },
  );
}

async function failEvent(orgId, eventId, { code, message, permanent }) {
  await finishEvent(orgId, eventId, {
    status: 'failed',
    error: { code, message: String(message ?? '').slice(0, 300), permanent: Boolean(permanent) },
  });
}

/** Meta lead (raw Graph object) → our intake input. */
async function toLeadInput(orgId, conn, mapped, phone) {
  const mapping = (conn.formMappings ?? []).find((m) => m.formId === mapped.formId) ?? null;
  let projectId = mapping?.projectId ?? null;
  if (projectId && !(await getProjectAccess(orgId, projectId))) projectId = null; // project deleted since
  return {
    mapping,
    input: {
      type: mapping?.type ?? 'buyer',
      name: mapped.name || 'Meta lead',
      phone,
      email: mapped.email,
      source: mapped.source,
      sourceDetail: {
        page: null,
        campaign: mapped.campaign,
        medium: mapped.isOrganic ? 'meta / organic' : 'meta / paid',
        formName: mapping?.formName ?? (mapped.formId ? `Form ${mapped.formId}` : null),
        referrer: null,
      },
      message: mapped.message,
      interest: { projectId, unitId: null },
      land: undefined,
    },
  };
}

/**
 * Import one leadgen id (job `meta.fetchLead`, the reconcile, or a manual retry).
 * Claims the event atomically, so overlapping runs never import twice; an event stuck in
 * `processing` (crashed worker) is taken over after 5 minutes.
 * @param {object} [opts.prefetched] the raw lead when the caller already has it (reconcile)
 * @param {object} [opts.job] the running job (to know whether this is the last attempt)
 * @returns {{ status }}
 */
export async function processLeadEvent(orgId, leadgenId, { prefetched, job, signal } = {}) {
  const now = new Date();
  const ev = await MetaLeadEvent.findOneAndUpdate(
    {
      orgId,
      leadgenId,
      $or: [
        { status: { $in: ['received', 'failed'] } },
        { status: 'processing', lockedUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LOCK_MS) },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after', lean: true },
  );
  if (!ev) return { status: 'skipped' };

  const conn = await loadConnection(orgId, { withToken: true });
  if (!conn || !conn.token || (ev.pageId && conn.pageId !== ev.pageId)) {
    await failEvent(orgId, ev._id, {
      code: 'NOT_CONNECTED',
      message: 'The Page is not connected',
      permanent: true,
    });
    return { status: 'failed' };
  }

  let raw = prefetched;
  if (!raw) {
    try {
      raw = await getLead(leadgenId, conn.token, { signal });
    } catch (err) {
      const lastTry = !job || job.attempts >= job.maxAttempts;
      if (err instanceof MetaGraphError && err.isAuth) {
        await markConnectionError(orgId, err);
        await failEvent(orgId, ev._id, { code: err.kind, message: err.message, permanent: false });
        throw new PermanentJobError(err.message); // a retry can't fix a token — the reconcile will
      }
      if (err instanceof MetaGraphError && err.retryable && !lastTry) {
        await MetaLeadEvent.updateOne(
          { orgId, _id: ev._id },
          {
            $set: {
              status: 'received',
              lockedUntil: null,
              error: { code: err.kind, message: err.message.slice(0, 300), permanent: false },
            },
          },
        );
        throw err; // job retries with backoff
      }
      await failEvent(orgId, ev._id, {
        code: err instanceof MetaGraphError ? err.kind : 'INTERNAL',
        message: err.message,
        permanent: err instanceof MetaGraphError ? err.permanent : false,
      });
      return { status: 'failed' };
    }
  }
  await markConnectionHealthy(orgId);

  const mapped = mapMetaLead(raw);
  const phone = normalizePhone(mapped.phone);
  if (!phone) {
    await failEvent(orgId, ev._id, {
      code: 'NO_PHONE',
      message: mapped.phone
        ? `Phone number not usable: ${String(mapped.phone).slice(0, 30)}`
        : 'The form has no phone number',
      permanent: true,
    });
    return { status: 'failed' };
  }

  const { input, mapping } = await toLeadInput(orgId, conn, mapped, phone);
  let res;
  try {
    res = await intakeLead(orgId, input, { onDuplicate: 'enquiry' });
  } catch (err) {
    // Release the claim so a retry (job backoff or the reconcile) can pick it up again.
    const lastTry = !job || job.attempts >= job.maxAttempts;
    if (!lastTry) {
      await MetaLeadEvent.updateOne(
        { orgId, _id: ev._id },
        {
          $set: {
            status: 'received',
            lockedUntil: null,
            error: {
              code: 'INTAKE_FAILED',
              message: String(err.message).slice(0, 300),
              permanent: false,
            },
          },
        },
      );
      throw err;
    }
    await failEvent(orgId, ev._id, {
      code: 'INTAKE_FAILED',
      message: err.message,
      permanent: false,
    });
    return { status: 'failed' };
  }
  const leadId = res.lead._id;
  await LeadActivity.create({
    orgId,
    leadId,
    type: 'meta_lead',
    at: mapped.createdTime ?? now,
    meta: {
      leadgenId,
      formId: mapped.formId,
      formName: mapping?.formName ?? null,
      adName: mapped.adName,
      adsetName: mapped.adsetName,
      campaign: mapped.campaign,
      organic: mapped.isOrganic,
      duplicate: Boolean(res.duplicate),
    },
  });
  await finishEvent(orgId, ev._id, {
    status: res.duplicate ? 'duplicate' : 'imported',
    leadId,
    formId: ev.formId ?? mapped.formId,
    adId: ev.adId ?? mapped.adId,
    metaCreatedAt: ev.metaCreatedAt ?? mapped.createdTime,
    error: { code: null, message: null, permanent: false },
  });
  await MetaConnection.updateOne({ orgId }, { $max: { lastLeadAt: now } });
  if (!res.duplicate) await sendAutoReply(orgId, res.lead, {});
  return { status: res.duplicate ? 'duplicate' : 'imported', leadId: String(leadId) };
}

// ── Reconcile ───────────────────────────────────────────────────────────────────

const dhakaHour = (d) => new Date(d.getTime() + 6 * HOUR).getUTCHours();

/** Nightly: once a day between 02:00 and 05:59 Dhaka, or any time if the last run is > 30 h old. */
export function isReconcileDue(conn, now = new Date()) {
  if (!conn || conn.status !== 'active') return false;
  const last = conn.lastReconciledAt?.getTime?.() ?? 0;
  const age = now.getTime() - last;
  if (age < 20 * HOUR) return false;
  return age > 30 * HOUR || (dhakaHour(now) >= 2 && dhakaHour(now) < 6);
}

/**
 * Re-read every form's leads from the last 48 hours and import any we haven't seen (or that
 * failed for a reason a retry can fix). Job `meta.reconcile`.
 */
export async function reconcile(orgId, { force = false, now = new Date(), signal } = {}) {
  const conn = await loadConnection(orgId, { withToken: true });
  if (!conn || !conn.token) return { skipped: 'not_connected' };
  if (!force && !isReconcileDue(conn, now)) return { skipped: 'not_due' };

  const since = new Date(now.getTime() - RECONCILE_HOURS * HOUR);
  const summary = { checked: 0, imported: 0, failed: 0, error: null };
  try {
    const forms = await listForms(conn.pageId, conn.token, { max: 100, signal });
    for (const form of forms) {
      for await (const batch of formLeadsSince(form.id, conn.token, since, { signal })) {
        for (const raw of batch) {
          const leadgenId = String(raw?.id ?? '');
          if (!/^\d{1,30}$/.test(leadgenId)) continue;
          summary.checked += 1;
          const known = await MetaLeadEvent.findOne({ orgId, leadgenId })
            .select('status error')
            .lean();
          if (
            known &&
            !(known.status === 'failed' && !known.error?.permanent) &&
            known.status !== 'received'
          )
            continue;
          if (!known) {
            try {
              await MetaLeadEvent.create({
                orgId,
                leadgenId,
                pageId: conn.pageId,
                formId: raw.form_id != null ? String(raw.form_id) : form.id,
                adId: raw.ad_id != null ? String(raw.ad_id) : null,
                via: 'reconcile',
                metaCreatedAt: parseMetaTime(raw.created_time),
              });
            } catch (err) {
              if (err?.code !== 11000) throw err; // the webhook got there first
            }
          }
          try {
            const r = await processLeadEvent(orgId, leadgenId, { prefetched: raw });
            if (r.status === 'imported' || r.status === 'duplicate') summary.imported += 1;
            else if (r.status === 'failed') summary.failed += 1;
          } catch (err) {
            summary.failed += 1;
            log.error({ err: { message: err.message }, leadgenId }, 'Reconcile: lead not imported');
          }
        }
      }
    }
  } catch (err) {
    summary.error = String(err.message ?? err).slice(0, 300);
    if (err instanceof MetaGraphError && err.isAuth) await markConnectionError(orgId, err);
    log.error({ err: { message: err.message } }, 'Meta reconcile stopped');
  }
  await MetaConnection.updateOne(
    { orgId },
    { $set: { lastReconciledAt: now, lastReconcile: summary } },
  );
  if (summary.imported) log.info(summary, 'Meta reconcile imported missed leads');
  return summary;
}

/** "Sync now" from the dashboard (also run right after connecting). */
export async function requestSync(orgId) {
  const job = await enqueue({
    orgId,
    type: 'meta.reconcile',
    payload: { force: true },
    dedupeKey: 'meta-sync',
  });
  return { queued: Boolean(job) };
}

// ── Import log ──────────────────────────────────────────────────────────────────

export async function listMetaEvents(orgId, { status, cursor, limit }) {
  const filter = { orgId, ...cursorFilter(cursor) };
  if (status) filter.status = status;
  const rows = await MetaLeadEvent.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  const leadIds = items.map((e) => e.leadId).filter(Boolean);
  const leads = leadIds.length
    ? await Lead.find({ orgId, _id: { $in: leadIds } })
        .select('name')
        .lean()
    : [];
  const names = new Map(leads.map((l) => [String(l._id), l.name]));
  return {
    items: items.map((e) => ({
      id: String(e._id),
      leadgenId: e.leadgenId,
      formId: e.formId ?? null,
      adId: e.adId ?? null,
      via: e.via,
      status: e.status,
      attempts: e.attempts ?? 0,
      leadId: e.leadId ? String(e.leadId) : null,
      leadName: e.leadId ? (names.get(String(e.leadId)) ?? null) : null,
      error: e.error?.code
        ? {
            code: e.error.code,
            message: e.error.message ?? null,
            permanent: Boolean(e.error.permanent),
          }
        : null,
      metaCreatedAt: e.metaCreatedAt ?? null,
      processedAt: e.processedAt ?? null,
      createdAt: e.createdAt,
    })),
    meta,
  };
}

/** Try a failed import again (after fixing the token, the form's phone question, …). */
export async function retryMetaEvent({ orgId, id, ctx }) {
  const ev = await MetaLeadEvent.findOneAndUpdate(
    { orgId, _id: id, status: 'failed' },
    {
      $set: {
        status: 'received',
        via: 'retry',
        error: { code: null, message: null, permanent: false },
      },
    },
    { returnDocument: 'after', lean: true },
  );
  if (!ev) throw new NotFoundError('No failed import with that id');
  await enqueue({
    orgId,
    type: 'meta.fetchLead',
    payload: { leadgenId: ev.leadgenId },
    priority: 5,
    dedupeKey: `meta-lead:${ev.leadgenId}`,
  });
  await audit(ctx, 'integration.meta.retry', { meta: { leadgenId: ev.leadgenId } });
  return { queued: true };
}
