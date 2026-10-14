import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { ForbiddenError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as accounts from '#modules/accounts/accounts.service.js';
import * as cheques from './cheque.service.js';
import * as life from './lifecycle.service.js';
import * as reports from './report.service.js';
import {
  zAllot,
  zCallItem,
  zCancel,
  zCancelPreview,
  zChargeCreate,
  zChequeBounce,
  zChequeClear,
  zChequeCreate,
  zChequeDeposit,
  zChequeList,
  zChequeReturn,
  zCollectionsReport,
  zDuesReport,
  zHandover,
  zPdcReport,
  zReasonBody,
  zRefund,
  zRegister,
  zReschedule,
  zTransfer,
} from './lifecycle.validation.js';

const byId = { params: { id: zid } };
const ctxOf = (req) => ({ org: req.org, user: req.user, ctx: auditContext(req) });

/** /api/v1/bookings/:id/… — B4.2 actions on a booking (mounted next to the B4.1 router). */
export const bookingActions = Router();
bookingActions.use(authenticate);

bookingActions.post(
  '/:id/cheques',
  authorize(P.CHEQUES_MANAGE),
  validate({ ...byId, body: zChequeCreate }),
  async (req, res) => {
    created(
      res,
      await cheques.receiveCheque({
        ...ctxOf(req),
        bookingId: req.valid.params.id,
        input: req.valid.body,
      }),
    );
  },
);

bookingActions.post(
  '/:id/charges',
  authorize(P.BOOKINGS_OVERRIDE),
  validate({ ...byId, body: zChargeCreate }),
  async (req, res) => {
    created(
      res,
      await life.addCharge({
        orgId: req.orgId,
        user: req.user,
        bookingId: req.valid.params.id,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

bookingActions.post(
  '/:id/charges/:itemId/waive',
  authorize(P.BOOKINGS_OVERRIDE),
  validate({ params: { id: zid, itemId: zid }, body: zReasonBody }),
  async (req, res) => {
    ok(
      res,
      await life.waiveCharge({
        orgId: req.orgId,
        user: req.user,
        bookingId: req.valid.params.id,
        itemId: req.valid.params.itemId,
        reason: req.valid.body.reason,
        ctx: auditContext(req),
      }),
    );
  },
);

bookingActions.post(
  '/:id/schedule/:itemId/call',
  authorize(P.BOOKINGS_OVERRIDE),
  validate({ params: { id: zid, itemId: zid }, body: zCallItem }),
  async (req, res) => {
    ok(
      res,
      await life.callItem({
        orgId: req.orgId,
        user: req.user,
        bookingId: req.valid.params.id,
        itemId: req.valid.params.itemId,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

bookingActions.put(
  '/:id/schedule',
  authorize(P.BOOKINGS_OVERRIDE),
  validate({ ...byId, body: zReschedule }),
  async (req, res) => {
    ok(
      res,
      await life.reschedule({
        orgId: req.orgId,
        user: req.user,
        bookingId: req.valid.params.id,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

const stage = (path, schema, fn) =>
  bookingActions.post(
    `/:id/${path}`,
    authorize(P.BOOKINGS_OVERRIDE),
    validate({ ...byId, body: schema }),
    async (req, res) => {
      const { booking, warnings } = await fn({
        ...ctxOf(req),
        bookingId: req.valid.params.id,
        input: req.valid.body,
      });
      ok(res, booking, { meta: { warnings } });
    },
  );
stage('allot', zAllot, life.allot);
stage('register', zRegister, life.register);
stage('handover', zHandover, life.handover);

bookingActions.post(
  '/:id/transfer',
  authorize(P.BOOKINGS_OVERRIDE),
  validate({ ...byId, body: zTransfer }),
  async (req, res) => {
    ok(
      res,
      await life.transfer({ ...ctxOf(req), bookingId: req.valid.params.id, input: req.valid.body }),
    );
  },
);

bookingActions.post(
  '/:id/cancel/preview',
  authorize(P.BOOKINGS_CANCEL),
  validate({ ...byId, body: zCancelPreview }),
  async (req, res) => {
    ok(
      res,
      await life.cancelPreview({
        orgId: req.orgId,
        user: req.user,
        bookingId: req.valid.params.id,
        input: req.valid.body,
      }),
    );
  },
);

bookingActions.post(
  '/:id/cancel',
  authorize(P.BOOKINGS_CANCEL),
  validate({ ...byId, body: zCancel }),
  async (req, res) => {
    ok(
      res,
      await life.cancel({ ...ctxOf(req), bookingId: req.valid.params.id, input: req.valid.body }),
    );
  },
);

bookingActions.post(
  '/:id/refunds',
  authorize(P.BOOKINGS_CANCEL),
  validate({ ...byId, body: zRefund }),
  async (req, res) => {
    created(
      res,
      await life.addRefund({
        ...ctxOf(req),
        bookingId: req.valid.params.id,
        input: req.valid.body,
      }),
    );
  },
);

/** /api/v1/cheques — the cheque / PDC register. */
export const chequeRouter = Router();
chequeRouter.use(authenticate);

const anyRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.BOOKINGS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};

chequeRouter.get('/', anyRead, validate({ query: zChequeList }), async (req, res) => {
  const { items, meta } = await accounts.listCheques(
    req.orgId,
    cheques.chequeScope(req.user),
    req.valid.query,
  );
  ok(res, items, { meta });
});

chequeRouter.get('/:id', anyRead, validate(byId), async (req, res) => {
  ok(res, await cheques.getCheque(req.orgId, req.user, req.valid.params.id));
});

const chequeAction = (path, schema, fn) =>
  chequeRouter.post(
    `/:id/${path}`,
    authorize(P.CHEQUES_MANAGE),
    validate({ ...byId, body: schema }),
    async (req, res) => {
      ok(res, await fn({ ...ctxOf(req), chequeId: req.valid.params.id, input: req.valid.body }));
    },
  );
chequeAction('deposit', zChequeDeposit, cheques.depositCheque);
chequeAction('clear', zChequeClear, cheques.clearCheque);
chequeAction('bounce', zChequeBounce, cheques.bounceCheque);
chequeAction('return', zChequeReturn, cheques.returnCheque);

/** /api/v1/reports — sales & collections (reports:read). */
export const reportRouter = Router();
reportRouter.use(authenticate, authorize(P.REPORTS_READ));

reportRouter.get('/dues', validate({ query: zDuesReport }), async (req, res) => {
  ok(res, await reports.duesReport(req.orgId, req.valid.query));
});
reportRouter.get('/collections', validate({ query: zCollectionsReport }), async (req, res) => {
  ok(res, await reports.collectionsReport(req.orgId, req.valid.query));
});
reportRouter.get('/pdcs', validate({ query: zPdcReport }), async (req, res) => {
  ok(res, await reports.pdcReport(req.orgId, req.valid.query));
});
