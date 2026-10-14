import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { zDraftBody } from './site.schema.js';
import { SOCIAL_NETWORKS } from './siteSettings.model.js';
import * as site from './site.service.js';

/** /api/v1/site — website content & SEO (B2b), `site:manage`. Contract: API.md › B2b. */
const router = Router();
router.use(authenticate, authorize(P.SITE_MANAGE));

const byKey = { key: z.string().trim().min(1).max(40) };
const zVersion = { version: z.number().int().min(0) };

router.get('/pages', async (req, res) => {
  ok(res, await site.listPages(req.orgId));
});

router.get('/pages/:key', validate({ params: byKey }), async (req, res) => {
  ok(res, await site.getPage(req.orgId, req.valid.params.key));
});

router.put('/pages/:key/draft', validate({ params: byKey, body: zDraftBody }), async (req, res) => {
  ok(
    res,
    await site.saveDraft({
      orgId: req.orgId,
      key: req.valid.params.key,
      input: req.valid.body,
      ctx: auditContext(req),
    }),
  );
});

router.get('/pages/:key/preview', validate({ params: byKey }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await site.getPreviewPage(req.orgId, req.valid.params.key));
});

router.post(
  '/pages/:key/publish',
  validate({
    params: byKey,
    body: { ...zVersion, note: z.string().trim().max(200).optional() },
  }),
  async (req, res) => {
    ok(
      res,
      await site.publishPage({
        orgId: req.orgId,
        key: req.valid.params.key,
        version: req.valid.body.version,
        note: req.valid.body.note,
        ctx: auditContext(req),
      }),
    );
  },
);

router.post(
  '/pages/:key/discard',
  validate({ params: byKey, body: zVersion }),
  async (req, res) => {
    ok(
      res,
      await site.discardDraft({
        orgId: req.orgId,
        key: req.valid.params.key,
        version: req.valid.body.version,
      }),
    );
  },
);

router.get('/pages/:key/revisions', validate({ params: byKey }), async (req, res) => {
  ok(res, await site.listRevisions(req.orgId, req.valid.params.key));
});

router.post(
  '/pages/:key/revisions/:n/restore',
  validate({
    params: { ...byKey, n: z.coerce.number().int().min(1).max(1_000_000) },
    body: zVersion,
  }),
  async (req, res) => {
    ok(
      res,
      await site.restoreRevision({
        orgId: req.orgId,
        key: req.valid.params.key,
        n: req.valid.params.n,
        version: req.valid.body.version,
        ctx: auditContext(req),
      }),
    );
  },
);

// ── site-wide SEO ───────────────────────────────────────────────────────────────

const lang = (max, extra) => {
  let s = z.string().trim().max(max);
  if (extra) s = s.refine(...extra);
  return z.object({ en: s.optional(), bn: s.optional() }).strict();
};

/**
 * Accepts the token or the whole tag Google/Bing hands out:
 * <meta name="google-site-verification" content="abc123" /> → abc123
 */
const zVerification = z
  .string()
  .trim()
  .max(400)
  .transform((v) => /content\s*=\s*["']([^"']*)["']/i.exec(v)?.[1]?.trim() ?? v)
  .pipe(
    z
      .string()
      .max(100)
      .regex(/^[\w-]*$/, 'Paste the code from the meta tag (letters, digits, - and _)'),
  );

const zSocial = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https:\/\/[^\s<>"']+$/.test(v), 'Use an https:// link')
  .transform((v) => v || null)
  .nullable();

router.get('/settings', async (req, res) => {
  ok(res, await site.getSiteSettings(req.orgId));
});

router.patch(
  '/settings',
  validate({
    body: {
      ...zVersion,
      titleTemplate: lang(120, [
        (v) => v === '' || v.includes('%s'),
        'Must contain %s (the page title)',
      ]).optional(),
      defaultDescription: lang(320).optional(),
      defaultOgImageMediaId: zid.nullable().optional(),
      verification: z
        .object({ google: zVerification.optional(), bing: zVerification.optional() })
        .strict()
        .optional(),
      social: z
        .object(Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, zSocial.optional()])))
        .strict()
        .optional(),
      indexing: z.boolean().optional(),
    },
  }),
  async (req, res) => {
    ok(
      res,
      await site.updateSiteSettings({
        orgId: req.orgId,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

export default router;
