import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { offsetQuery } from '#shared/utils/pagination.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as units from '#modules/units/unit.service.js';
import {
  zUnitBulk,
  zUnitCreate,
  zUnitListQuery,
  zUnitPrices,
} from '#modules/units/unit.validation.js';
import * as floorplans from '#modules/floorplans/floorplan.service.js';
import { zFloorPlanCreate } from '#modules/floorplans/floorplan.service.js';
import * as projects from './project.service.js';
import {
  zApartmentPricing,
  zBlockCreate,
  zBlockPatch,
  zPlotPricing,
  zProjectCreate,
  zProjectListQuery,
  zProjectPatch,
  zVersion,
} from './project.validation.js';

/** /api/v1/projects — staff inventory management (B2). */
const router = Router();
router.use(authenticate);

const byId = { params: { id: zid } };

router.get(
  '/',
  authorize(P.PROJECTS_READ),
  validate({ query: { ...zProjectListQuery, ...offsetQuery } }),
  async (req, res) => {
    const { items, meta } = await projects.listProjects(req.orgId, req.valid.query);
    ok(res, items, { meta });
  },
);

router.post(
  '/',
  authorize(P.PROJECTS_WRITE),
  validate({ body: zProjectCreate }),
  async (req, res) => {
    created(
      res,
      await projects.createProject({
        orgId: req.orgId,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

router.get('/:id', authorize(P.PROJECTS_READ), validate(byId), async (req, res) => {
  ok(res, await projects.getProjectDetail(req.orgId, req.valid.params.id));
});

router.patch(
  '/:id',
  authorize(P.PROJECTS_WRITE),
  validate({ ...byId, body: zProjectPatch }),
  async (req, res) => {
    ok(
      res,
      await projects.updateProject({
        orgId: req.orgId,
        id: req.valid.params.id,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

router.delete('/:id', authorize(P.PROJECTS_WRITE), validate(byId), async (req, res) => {
  await projects.deleteProject({
    orgId: req.orgId,
    id: req.valid.params.id,
    ctx: auditContext(req),
  });
  noContent(res);
});

/** Rate card: full replacement. The body shape depends on the project kind. */
router.put(
  '/:id/pricing',
  authorize(P.PRICING_WRITE),
  validate({
    ...byId,
    body: z.object({ version: zVersion, pricing: z.unknown() }).strict(),
  }),
  async (req, res) => {
    const project = await projects.getProject(req.orgId, req.valid.params.id);
    const schema = project.kind === 'plot' ? zPlotPricing : zApartmentPricing;
    const pricing = z
      .object({ pricing: schema })
      .parse({ pricing: req.valid.body.pricing }).pricing;
    const result = await projects.replacePricing({
      orgId: req.orgId,
      id: project._id,
      pricing,
      version: req.valid.body.version,
      ctx: auditContext(req),
    });
    ok(res, result.project, { meta: { repricedUnits: result.repricedUnits } });
  },
);

// ── Blocks ──
router.get('/:id/blocks', authorize(P.PROJECTS_READ), validate(byId), async (req, res) => {
  ok(res, await projects.listBlocks(req.orgId, req.valid.params.id));
});

router.post(
  '/:id/blocks',
  authorize(P.PROJECTS_WRITE),
  validate({ ...byId, body: zBlockCreate }),
  async (req, res) => {
    created(
      res,
      await projects.createBlock({
        orgId: req.orgId,
        projectId: req.valid.params.id,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

const blockParams = { params: { id: zid, blockId: zid } };

router.patch(
  '/:id/blocks/:blockId',
  authorize(P.PROJECTS_WRITE),
  validate({ ...blockParams, body: zBlockPatch }),
  async (req, res) => {
    await projects.getBlock(req.orgId, req.valid.params.id, req.valid.params.blockId);
    ok(
      res,
      await projects.updateBlock({
        orgId: req.orgId,
        blockId: req.valid.params.blockId,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

router.delete(
  '/:id/blocks/:blockId',
  authorize(P.PROJECTS_WRITE),
  validate(blockParams),
  async (req, res) => {
    await projects.getBlock(req.orgId, req.valid.params.id, req.valid.params.blockId);
    await projects.deleteBlock({
      orgId: req.orgId,
      blockId: req.valid.params.blockId,
      ctx: auditContext(req),
    });
    noContent(res);
  },
);

// ── Units of a project ──
router.get(
  '/:id/units',
  authorize(P.UNITS_READ),
  validate({ ...byId, query: zUnitListQuery }),
  async (req, res) => {
    const { items, meta } = await units.listUnits(req.orgId, req.valid.params.id, req.valid.query);
    ok(res, items, { meta });
  },
);

router.post(
  '/:id/units',
  authorize(P.UNITS_WRITE),
  validate({ ...byId, body: zUnitCreate }),
  async (req, res) => {
    created(
      res,
      await units.createUnit({
        orgId: req.orgId,
        projectId: req.valid.params.id,
        input: req.valid.body,
        user: req.user,
        ctx: auditContext(req),
      }),
    );
  },
);

router.post(
  '/:id/units/bulk',
  authorize(P.UNITS_WRITE),
  validate({ ...byId, body: zUnitBulk }),
  async (req, res) => {
    const result = await units.bulkCreateUnits({
      orgId: req.orgId,
      projectId: req.valid.params.id,
      inputs: req.valid.body.units,
      user: req.user,
      ctx: auditContext(req),
    });
    created(res, result.items, { meta: { created: result.created } });
  },
);

// Price matrix: per-unit overrides in bulk (admin pricing permission).
router.post(
  '/:id/units/prices',
  authorize(P.PRICING_WRITE),
  validate({ ...byId, body: zUnitPrices }),
  async (req, res) => {
    const result = await units.setUnitPrices({
      orgId: req.orgId,
      projectId: req.valid.params.id,
      items: req.valid.body.items,
      dryRun: req.valid.body.dryRun ?? false,
      ctx: auditContext(req),
    });
    ok(res, result.items, { meta: { dryRun: result.dryRun, changed: result.changed ?? null } });
  },
);

// ── Floor plans of a project ──
router.get('/:id/floorplans', authorize(P.PROJECTS_READ), validate(byId), async (req, res) => {
  ok(res, await floorplans.listFloorPlans(req.orgId, req.valid.params.id));
});

router.post(
  '/:id/floorplans',
  authorize(P.PROJECTS_WRITE),
  validate({ ...byId, body: zFloorPlanCreate }),
  async (req, res) => {
    created(
      res,
      await floorplans.createFloorPlan({
        orgId: req.orgId,
        projectId: req.valid.params.id,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

export default router;
