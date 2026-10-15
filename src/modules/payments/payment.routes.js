import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { ok } from '#shared/utils/response.js';
import { authenticate, authorize, authorizeAny } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { ONLINE_PAYMENT_STATUSES } from './onlinePayment.model.js';
import * as payments from './payment.service.js';

/**
 * /api/v1/online-payments — staff view of SSLCommerz payments (B5.2).
 * Read: online_payments:review or bookings:read_all (all), the seller (own bookings).
 * Decide held payments: online_payments:review.
 */
const router = Router();
router.use(authenticate);

const byId = { params: { id: zid } };
const read = authorizeAny(P.ONLINE_PAYMENTS_REVIEW, P.BOOKINGS_READ_ALL, P.BOOKINGS_READ);
const review = authorize(P.ONLINE_PAYMENTS_REVIEW);

router.get(
  '/',
  read,
  validate({
    query: {
      status: z.enum(ONLINE_PAYMENT_STATUSES).optional(),
      bookingId: zid.optional(),
      ...cursorQuery,
    },
  }),
  async (req, res) => {
    const { items, meta } = await payments.listPayments(req.orgId, req.user, req.valid.query);
    ok(res, items, { meta });
  },
);

router.get('/:id', read, validate(byId), async (req, res) => {
  ok(res, await payments.getPayment(req.orgId, req.user, req.valid.params.id));
});

router.post('/:id/recheck', review, validate(byId), async (req, res) => {
  ok(
    res,
    await payments.recheckPayment({
      orgId: req.orgId,
      user: req.user,
      id: req.valid.params.id,
      ctx: auditContext(req),
    }),
  );
});

router.post(
  '/:id/approve',
  review,
  validate({ ...byId, body: z.object({ note: z.string().trim().max(500).optional() }).strict() }),
  async (req, res) => {
    ok(
      res,
      await payments.approveReview({
        orgId: req.orgId,
        user: req.user,
        id: req.valid.params.id,
        note: req.valid.body.note,
        ctx: auditContext(req),
      }),
    );
  },
);

router.post(
  '/:id/reject',
  review,
  validate({ ...byId, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() }),
  async (req, res) => {
    ok(
      res,
      await payments.rejectReview({
        org: req.org,
        user: req.user,
        id: req.valid.params.id,
        reason: req.valid.body.reason,
        ctx: auditContext(req),
      }),
    );
  },
);

export default router;
