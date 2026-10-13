import { Router } from 'express';
import { getIntegrationConfig } from '#integrations/config.js';
import { smsInfo } from '#integrations/sms/index.js';
import { P } from '#shared/auth/permissions.js';
import { BadRequestError } from '#shared/errors/AppError.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { normalizeBdPhone } from '#shared/utils/phone.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { auditContext, audit } from '#modules/audit/audit.service.js';
import { authenticate, authorize, authorizeAny } from '#modules/auth/auth.middleware.js';
import { companyName, renderAutoReply, SAMPLE_NAMES } from '#modules/leads/autoReplyText.js';
import * as meta from '#modules/meta/meta.service.js';
import { listSmsMessages, previewSms, queueSms, smsSummary } from '#modules/sms/sms.service.js';
import {
  zMetaConnect,
  zMetaEvents,
  zMetaForms,
  zSmsList,
  zSmsPreview,
  zSmsTest,
} from './integration.validation.js';

/**
 * /api/v1/integrations — connections to outside services (B3.2).
 * Setup screens need `settings:integrations` (admin). The SMS delivery log and the length/cost
 * preview are also open to `pipeline:manage` (managers edit the auto-reply text).
 */
const router = Router();
router.use(authenticate);

const admin = authorize(P.SETTINGS_INTEGRATIONS);
const adminOrPipeline = authorizeAny(P.SETTINGS_INTEGRATIONS, P.PIPELINE_MANAGE);

router.get('/', admin, async (req, res) => {
  const [metaStatus, sms] = await Promise.all([meta.metaStatus(req.orgId), smsSummary(req.orgId)]);
  ok(res, {
    email: { enabled: getIntegrationConfig(req.orgId, 'email').enabled },
    sms: { ...smsInfo(req.orgId), thisMonth: sms },
    meta: metaStatus,
  });
});

// ── Meta Lead Ads ───────────────────────────────────────────────────────────────

router.put('/meta', admin, limits.sensitive, validate({ body: zMetaConnect }), async (req, res) => {
  ok(
    res,
    await meta.connectPage({
      orgId: req.orgId,
      user: req.user,
      ...req.valid.body,
      ctx: auditContext(req),
    }),
  );
});

router.delete('/meta', admin, async (req, res) => {
  await meta.disconnectPage({ orgId: req.orgId, ctx: auditContext(req) });
  noContent(res);
});

router.get('/meta/forms', admin, async (req, res) => {
  ok(res, await meta.listPageForms(req.orgId));
});

router.put('/meta/forms', admin, validate({ body: zMetaForms }), async (req, res) => {
  ok(
    res,
    await meta.updateFormMappings({ orgId: req.orgId, ...req.valid.body, ctx: auditContext(req) }),
  );
});

router.get('/meta/leads', admin, validate({ query: zMetaEvents }), async (req, res) => {
  const { items, meta: page } = await meta.listMetaEvents(req.orgId, req.valid.query);
  ok(res, items, { meta: page });
});

router.post('/meta/leads/:id/retry', admin, validate({ params: { id: zid } }), async (req, res) => {
  ok(
    res,
    await meta.retryMetaEvent({
      orgId: req.orgId,
      id: req.valid.params.id,
      ctx: auditContext(req),
    }),
  );
});

router.post('/meta/sync', admin, async (req, res) => {
  ok(res, await meta.requestSync(req.orgId));
});

// ── SMS ─────────────────────────────────────────────────────────────────────────

router.get('/sms/messages', adminOrPipeline, validate({ query: zSmsList }), async (req, res) => {
  const { items, meta: page } = await listSmsMessages(req.orgId, req.valid.query);
  ok(res, items, { meta: page });
});

router.post('/sms/preview', adminOrPipeline, validate({ body: zSmsPreview }), async (req, res) => {
  const { text, locale } = req.valid.body;
  const rendered = locale
    ? renderAutoReply(text, { name: SAMPLE_NAMES[locale], company: companyName(req.org, locale) })
    : text;
  ok(res, { rendered, ...previewSms(req.orgId, rendered), ...smsInfo(req.orgId) });
});

router.post(
  '/sms/test',
  admin,
  limits.sensitive,
  validate({ body: zSmsTest }),
  async (req, res) => {
    const to = normalizeBdPhone(req.valid.body.to);
    if (!to) {
      throw new BadRequestError('Enter a Bangladesh mobile number', {
        code: 'INVALID_PHONE',
        details: [{ path: 'to', message: 'Bangladesh mobile only' }],
      });
    }
    const text =
      req.valid.body.text ??
      `${companyName(req.org, 'en') || 'PrimePlot'}: test SMS from PrimePlot.`;
    const sms = await queueSms({
      orgId: req.orgId,
      to,
      text,
      purpose: 'test',
      createdBy: req.user.id,
    });
    await audit(auditContext(req), 'integration.sms.test', {
      entity: { type: 'SmsMessage', id: sms.id },
      meta: { to, segments: sms.segments },
    });
    created(res, sms);
  },
);

export default router;
