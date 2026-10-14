import { Router } from 'express';
import { z } from 'zod';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { offsetQuery } from '#shared/utils/pagination.js';
import { zSlug } from '#modules/projects/project.validation.js';
import { PROJECT_KINDS, PROJECT_STAGES } from '#modules/projects/project.model.js';
import * as catalog from './public.service.js';
import * as site from '#modules/site/site.service.js';
import { verifySiteSignature } from '#integrations/revalidate/index.js';
import { NotFoundError } from '#shared/errors/AppError.js';
import * as construction from '#modules/construction/construction.service.js';

/**
 * /api/v1/public — website catalogue, no auth (B2). GET only.
 * Short shared cache; the Next.js site caches by tag and is revalidated by the API on change.
 */
const router = Router();

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  next();
});

router.get(
  '/projects',
  validate({
    query: {
      q: z.string().trim().min(1).max(100).optional(),
      kind: z.enum(PROJECT_KINDS).optional(),
      stage: z.enum(PROJECT_STAGES).optional(),
      city: z.string().trim().min(1).max(80).optional(),
      area: z.string().trim().min(1).max(100).optional(),
      featured: z.enum(['true', 'false']).optional(),
      ...offsetQuery,
    },
  }),
  async (req, res) => {
    const { items, meta } = await catalog.listPublicProjects(req.orgId, req.valid.query);
    ok(res, items, { meta });
  },
);

// Website content & SEO (B2b) — cached by the site under the `site` tag.
router.get('/site', async (req, res) => {
  ok(res, await site.getPublicSite(req.orgId));
});

router.get(
  '/site/pages/:key',
  validate({
    params: { key: z.string().trim().min(1).max(40) },
    query: { preview: z.literal('1').optional() },
  }),
  async (req, res) => {
    const { key } = req.valid.params;
    if (!req.valid.query.preview) return ok(res, await site.getPublicPage(req.orgId, key));
    // Draft preview for the website's preview mode — signed by the Next.js server, never a browser.
    const signed = verifySiteSignature(
      `preview:${key}`,
      req.get('x-primeplot-timestamp'),
      req.get('x-primeplot-signature'),
    );
    if (!signed) throw new NotFoundError('Not found');
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await site.getPreviewPage(req.orgId, key));
  },
);

router.get(
  '/projects/:slug/updates',
  validate({
    params: { slug: zSlug },
    query: {
      cursor: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(20).default(10),
    },
  }),
  async (req, res) => {
    const { items, meta } = await construction.listPublicUpdates(
      req.orgId,
      req.valid.params.slug,
      req.valid.query,
    );
    ok(res, items, { meta });
  },
);

router.get(
  '/construction/latest',
  validate({ query: { limit: z.coerce.number().int().min(1).max(6).default(3) } }),
  async (req, res) => {
    ok(res, await construction.latestPublic(req.orgId, req.valid.query));
  },
);

router.get('/projects/:slug', validate({ params: { slug: zSlug } }), async (req, res) => {
  ok(res, await catalog.getPublicProject(req.orgId, req.valid.params.slug));
});

router.get(
  '/projects/:slug/units',
  validate({
    params: { slug: zSlug },
    query: {
      blockId: zid.optional(),
      floor: z.coerce.number().int().min(-5).max(200).optional(),
      status: z.enum(['available', 'held', 'sold']).optional(),
      bedrooms: z.coerce.number().int().min(0).max(20).optional(),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    },
  }),
  async (req, res) => {
    const { items, meta } = await catalog.listPublicUnitsOf(
      req.orgId,
      req.valid.params.slug,
      req.valid.query,
    );
    ok(res, items, { meta });
  },
);

router.get('/units/:id', validate({ params: { id: zid } }), async (req, res) => {
  ok(res, await catalog.getPublicUnitDetail(req.orgId, req.valid.params.id));
});

router.get(
  '/floorplans/:id',
  validate({
    params: { id: zid },
    query: { floor: z.coerce.number().int().min(-5).max(200).optional() },
  }),
  async (req, res) => {
    ok(res, await catalog.getPublicFloorPlan(req.orgId, req.valid.params.id, req.valid.query));
  },
);

export default router;
