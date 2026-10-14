import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as construction from './construction.service.js';
import { zUpdateCreate, zUpdateList, zUpdatePatch } from './construction.validation.js';

/** Construction updates (B2b). Contract: API.md › B2b › Construction updates. */
const byId = { params: { id: zid } };

/** Mounted at /projects (before the project router): /projects/:id/updates. */
export const projectUpdatesRouter = Router();
projectUpdatesRouter.get(
  '/:id/updates',
  authenticate,
  authorize(P.PROJECTS_READ),
  validate({ ...byId, query: zUpdateList }),
  async (req, res) => {
    const { items, meta } = await construction.listUpdates(
      req.orgId,
      req.valid.params.id,
      req.valid.query,
    );
    ok(res, items, { meta });
  },
);
projectUpdatesRouter.post(
  '/:id/updates',
  authenticate,
  authorize(P.PROJECTS_WRITE),
  validate({ ...byId, body: zUpdateCreate }),
  async (req, res) => {
    created(
      res,
      await construction.createUpdate({
        orgId: req.orgId,
        projectId: req.valid.params.id,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

/** Mounted at /construction-updates. */
export const updatesRouter = Router();
updatesRouter.use(authenticate, authorize(P.PROJECTS_WRITE));
updatesRouter.patch('/:id', validate({ ...byId, body: zUpdatePatch }), async (req, res) => {
  ok(
    res,
    await construction.updateUpdate({
      orgId: req.orgId,
      id: req.valid.params.id,
      patch: req.valid.body,
      ctx: auditContext(req),
    }),
  );
});
updatesRouter.delete('/:id', validate(byId), async (req, res) => {
  await construction.deleteUpdate({
    orgId: req.orgId,
    id: req.valid.params.id,
    ctx: auditContext(req),
  });
  noContent(res);
});
