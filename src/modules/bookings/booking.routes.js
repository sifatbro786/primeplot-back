import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { ForbiddenError } from '#shared/errors/AppError.js';
import { idempotencyKey } from '#shared/middleware/idempotency.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { zPayment } from '#modules/accounts/accounts.validation.js';
import * as bookings from './booking.service.js';
import * as plans from './plan.service.js';
import {
  zBookingCreate,
  zBookingList,
  zBookingPatch,
  zBookingPreview,
  zPlanCreate,
  zPlanList,
  zPlanPatch,
} from './booking.validation.js';

const anyBookingRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.BOOKINGS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};
const byId = { params: { id: zid } };

/** /api/v1/bookings — sales (B4.1). Static paths before /:id. */
export const bookingRouter = Router();
bookingRouter.use(authenticate);

bookingRouter.get('/', anyBookingRead, validate({ query: zBookingList }), async (req, res) => {
  const { items, meta } = await bookings.listBookings(req.orgId, req.user, req.valid.query);
  ok(res, items, { meta });
});

bookingRouter.post(
  '/preview',
  authorize(P.BOOKINGS_CREATE),
  validate({ body: zBookingPreview }),
  async (req, res) => {
    ok(
      res,
      await bookings.previewBooking({ orgId: req.orgId, user: req.user, input: req.valid.body }),
    );
  },
);

bookingRouter.post(
  '/',
  authorize(P.BOOKINGS_CREATE),
  idempotencyKey,
  validate({ body: zBookingCreate }),
  async (req, res) => {
    const { booking, replayed } = await bookings.createBooking({
      org: req.org,
      user: req.user,
      input: req.valid.body,
      idempotencyKey: req.idempotencyKey,
      ctx: auditContext(req),
    });
    if (replayed) ok(res, booking, { meta: { replayed: true } });
    else created(res, booking);
  },
);

bookingRouter.get('/:id', anyBookingRead, validate(byId), async (req, res) => {
  ok(res, await bookings.getBookingDetail(req.orgId, req.user, req.valid.params.id));
});

bookingRouter.patch(
  '/:id',
  authorize(P.BOOKINGS_CREATE),
  validate({ ...byId, body: zBookingPatch }),
  async (req, res) => {
    ok(
      res,
      await bookings.updateBooking({
        orgId: req.orgId,
        user: req.user,
        id: req.valid.params.id,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

bookingRouter.get('/:id/ledger', anyBookingRead, validate(byId), async (req, res) => {
  ok(res, await bookings.getBookingLedger(req.orgId, req.user, req.valid.params.id));
});

bookingRouter.post(
  '/:id/receipts',
  authorize(P.RECEIPTS_CREATE),
  idempotencyKey,
  validate({ ...byId, body: zPayment }),
  async (req, res) => {
    const { receipt, replayed } = await bookings.addPayment({
      org: req.org,
      user: req.user,
      bookingId: req.valid.params.id,
      input: req.valid.body,
      idempotencyKey: req.idempotencyKey,
      ctx: auditContext(req),
    });
    if (replayed) ok(res, receipt, { meta: { replayed: true } });
    else created(res, receipt);
  },
);

/** /api/v1/payment-plans — plan templates. */
export const planRouter = Router();
planRouter.use(authenticate);

planRouter.get('/', anyBookingRead, validate({ query: zPlanList }), async (req, res) => {
  ok(res, await plans.listPlans(req.orgId, req.valid.query));
});

planRouter.post(
  '/',
  authorize(P.PLANS_MANAGE),
  validate({ body: zPlanCreate }),
  async (req, res) => {
    created(
      res,
      await plans.createPlan({ orgId: req.orgId, input: req.valid.body, ctx: auditContext(req) }),
    );
  },
);

planRouter.patch(
  '/:id',
  authorize(P.PLANS_MANAGE),
  validate({ ...byId, body: zPlanPatch }),
  async (req, res) => {
    ok(
      res,
      await plans.updatePlan({
        orgId: req.orgId,
        id: req.valid.params.id,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

planRouter.delete('/:id', authorize(P.PLANS_MANAGE), validate(byId), async (req, res) => {
  await plans.deletePlan({ orgId: req.orgId, id: req.valid.params.id, ctx: auditContext(req) });
  noContent(res);
});
