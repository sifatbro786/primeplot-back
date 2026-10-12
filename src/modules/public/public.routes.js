import { Router } from 'express';
import { z } from 'zod';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { offsetQuery } from '#shared/utils/pagination.js';
import { zSlug } from '#modules/projects/project.validation.js';
import { PROJECT_KINDS, PROJECT_STAGES } from '#modules/projects/project.model.js';
import * as catalog from './public.service.js';

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
