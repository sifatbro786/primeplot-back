import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { noContent, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as floorplans from './floorplan.service.js';
import { zFloorPlanPatch } from './floorplan.service.js';

/** /api/v1/floorplans/:id (B2). Listing/creating lives under /projects/:id/floorplans. */
const router = Router();
router.use(authenticate);

const byId = { params: { id: zid } };

router.get(
  '/:id',
  authorize(P.PROJECTS_READ),
  validate({ ...byId, query: { floor: z.coerce.number().int().min(-5).max(200).optional() } }),
  async (req, res) => {
    ok(res, await floorplans.getFloorPlan(req.orgId, req.valid.params.id, req.valid.query));
  },
);

router.patch(
  '/:id',
  authorize(P.PROJECTS_WRITE),
  validate({ ...byId, body: zFloorPlanPatch }),
  async (req, res) => {
    ok(
      res,
      await floorplans.updateFloorPlan({
        orgId: req.orgId,
        id: req.valid.params.id,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

router.delete('/:id', authorize(P.PROJECTS_WRITE), validate(byId), async (req, res) => {
  await floorplans.deleteFloorPlan({
    orgId: req.orgId,
    id: req.valid.params.id,
    ctx: auditContext(req),
  });
  noContent(res);
});

export default router;
