import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { ConflictError, ForbiddenError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { authenticate, authorize, authorizeAny } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { getVisibleCustomer } from '#modules/customers/customer.service.js';
import * as accounts from './portalAccount.service.js';
import * as review from './review.service.js';
import {
  zInvite,
  zPortalAccess,
  zProfileRequestList,
  zReason,
  zSlipApprove,
  zStaffSlipList,
} from './portal.validation.js';

/**
 * Staff side of the customer portal (B5.1):
 *   /customers/:id/portal          login status, invite / resend, switch off/on
 *   /payment-slips                 bank-slip verification queue
 *   /profile-requests              contact-detail change requests
 */
const byId = { params: { id: zid } };
const ctxOf = (req) => ({ org: req.org, user: req.user, ctx: auditContext(req) });
const anyBookingRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.BOOKINGS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};

/** Mounted at /customers (before the customers router). */
export const customerPortalRouter = Router();
customerPortalRouter.use(authenticate);

customerPortalRouter.get('/:id/portal', anyBookingRead, validate(byId), async (req, res) => {
  const c = await getVisibleCustomer(req.orgId, req.user, req.valid.params.id);
  ok(res, await accounts.portalStatus(req.orgId, c));
});

customerPortalRouter.post(
  '/:id/portal/invite',
  authorize(P.BOOKINGS_CREATE),
  validate({ ...byId, body: zInvite }),
  async (req, res) => {
    const c = await getVisibleCustomer(req.orgId, req.user, req.valid.params.id);
    // A login is for someone who owns (or co-owns) a unit — not for every enquiry.
    const onBooking = await Booking.exists({
      orgId: req.orgId,
      status: 'active',
      $or: [{ customerId: c._id }, { coApplicantIds: c._id }],
    });
    if (!onBooking) {
      throw new ConflictError('This customer is not on an active booking', {
        code: 'NOT_ON_A_BOOKING',
      });
    }
    const result = await accounts.invitePortalUser({
      org: req.org,
      customerId: c._id,
      by: req.user,
      force: req.valid.body.force,
      ctx: auditContext(req),
    });
    ok(res, {
      ...result,
      portal: await accounts.portalStatus(req.orgId, { ...c, portalUserId: result.userId }),
    });
  },
);

customerPortalRouter.patch(
  '/:id/portal',
  authorize(P.PORTAL_MANAGE),
  validate({ ...byId, body: zPortalAccess }),
  async (req, res) => {
    const c = await getVisibleCustomer(req.orgId, req.user, req.valid.params.id);
    ok(
      res,
      await accounts.setPortalAccess({
        org: req.org,
        customerId: c._id,
        enabled: req.valid.body.enabled,
        ctx: auditContext(req),
      }),
    );
  },
);

/** /api/v1/payment-slips */
export const slipRouter = Router();
slipRouter.use(authenticate);
const slipRead = authorizeAny(P.PAYMENT_SLIPS_VERIFY, P.BOOKINGS_READ_ALL, P.BOOKINGS_READ);
const slipVerify = authorize(P.PAYMENT_SLIPS_VERIFY);

slipRouter.get('/', slipRead, validate({ query: zStaffSlipList }), async (req, res) => {
  const { items, meta } = await review.listSlips(req.orgId, req.user, req.valid.query);
  ok(res, items, { meta });
});

slipRouter.get('/:id', slipRead, validate(byId), async (req, res) => {
  ok(res, await review.getSlip(req.orgId, req.user, req.valid.params.id));
});

slipRouter.post(
  '/:id/approve',
  slipVerify,
  validate({ ...byId, body: zSlipApprove }),
  async (req, res) => {
    ok(
      res,
      await review.approveSlip({ ...ctxOf(req), id: req.valid.params.id, input: req.valid.body }),
    );
  },
);

slipRouter.post(
  '/:id/reject',
  slipVerify,
  validate({ ...byId, body: zReason }),
  async (req, res) => {
    ok(
      res,
      await review.rejectSlip({
        ...ctxOf(req),
        id: req.valid.params.id,
        reason: req.valid.body.reason,
      }),
    );
  },
);

/** /api/v1/profile-requests */
export const profileRequestRouter = Router();
profileRequestRouter.use(authenticate, authorize(P.PORTAL_MANAGE));

profileRequestRouter.get('/', validate({ query: zProfileRequestList }), async (req, res) => {
  const { items, meta } = await review.listProfileRequests(req.orgId, req.valid.query);
  ok(res, items, { meta });
});

profileRequestRouter.get('/:id', validate(byId), async (req, res) => {
  ok(res, await review.getProfileRequest(req.orgId, req.valid.params.id));
});

profileRequestRouter.post('/:id/approve', validate(byId), async (req, res) => {
  ok(res, await review.approveProfileRequest({ ...ctxOf(req), id: req.valid.params.id }));
});

profileRequestRouter.post('/:id/reject', validate({ ...byId, body: zReason }), async (req, res) => {
  ok(
    res,
    await review.rejectProfileRequest({
      ...ctxOf(req),
      id: req.valid.params.id,
      reason: req.valid.body.reason,
    }),
  );
});
