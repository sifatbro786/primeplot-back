import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { ForbiddenError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as customers from './customer.service.js';
import { zCustomerCreate, zCustomerList, zCustomerPatch } from './customer.validation.js';

/** /api/v1/customers — buyer profiles (B4). */
const router = Router();
router.use(authenticate);

const anyRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.BOOKINGS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};
const byId = { params: { id: zid } };

router.get('/', anyRead, validate({ query: zCustomerList }), async (req, res) => {
  const { items, meta } = await customers.listCustomers(req.orgId, req.user, req.valid.query);
  ok(res, items, { meta });
});

router.post(
  '/',
  authorize(P.BOOKINGS_CREATE),
  validate({ body: zCustomerCreate }),
  async (req, res) => {
    created(
      res,
      await customers.createCustomer({
        orgId: req.orgId,
        user: req.user,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

router.get('/:id', anyRead, validate(byId), async (req, res) => {
  ok(
    res,
    customers.toCustomer(
      await customers.getVisibleCustomer(req.orgId, req.user, req.valid.params.id),
    ),
  );
});

router.patch(
  '/:id',
  authorize(P.BOOKINGS_CREATE),
  validate({ ...byId, body: zCustomerPatch }),
  async (req, res) => {
    ok(
      res,
      await customers.updateCustomer({
        orgId: req.orgId,
        user: req.user,
        id: req.valid.params.id,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

export default router;
