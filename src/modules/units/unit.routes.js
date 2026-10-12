import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { noContent, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as units from './unit.service.js';
import { zBlockUnit, zExtendHold, zHold, zUnitPatch } from './unit.validation.js';

/** /api/v1/units/:id — one unit: details, edits, and status actions (B2). */
const router = Router();
router.use(authenticate);

const byId = { params: { id: zid } };
const base = (req) => ({ orgId: req.orgId, unitId: req.valid.params.id, ctx: auditContext(req) });

router.get('/:id', authorize(P.UNITS_READ), validate(byId), async (req, res) => {
  ok(res, await units.getUnitDetail(req.orgId, req.valid.params.id));
});

router.patch(
  '/:id',
  authorize(P.UNITS_WRITE),
  validate({ ...byId, body: zUnitPatch }),
  async (req, res) => {
    ok(
      res,
      await units.updateUnit({
        orgId: req.orgId,
        id: req.valid.params.id,
        patch: req.valid.body,
        user: req.user,
        ctx: auditContext(req),
      }),
    );
  },
);

router.delete('/:id', authorize(P.UNITS_WRITE), validate(byId), async (req, res) => {
  await units.deleteUnit({ orgId: req.orgId, id: req.valid.params.id, ctx: auditContext(req) });
  noContent(res);
});

// ── Status actions (atomic; 409 UNIT_STATE_CONFLICT when someone got there first) ──
router.post(
  '/:id/hold',
  authorize(P.UNITS_HOLD),
  validate({ ...byId, body: zHold }),
  async (req, res) => {
    ok(res, await units.holdUnit({ ...base(req), user: req.user, ...req.valid.body }));
  },
);

router.post(
  '/:id/hold/extend',
  authorize(P.UNITS_WRITE),
  validate({ ...byId, body: zExtendHold }),
  async (req, res) => {
    ok(res, await units.extendHold({ ...base(req), hours: req.valid.body.hours }));
  },
);

router.post('/:id/release', authorize(P.UNITS_HOLD), validate(byId), async (req, res) => {
  ok(res, await units.releaseUnit({ ...base(req), user: req.user }));
});

router.post(
  '/:id/block',
  authorize(P.UNITS_BLOCK),
  validate({ ...byId, body: zBlockUnit }),
  async (req, res) => {
    ok(res, await units.blockUnit({ ...base(req), ...req.valid.body }));
  },
);

router.post('/:id/unblock', authorize(P.UNITS_BLOCK), validate(byId), async (req, res) => {
  ok(res, await units.unblockUnit(base(req)));
});

export default router;
