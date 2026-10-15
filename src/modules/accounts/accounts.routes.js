import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { ForbiddenError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
// Route-level use only: receipts are written through the bookings service (one-way dependency).
import * as bookings from '#modules/bookings/booking.service.js';
import * as accounts from './accounts.service.js';
import {
  zBankCreate,
  zBankPatch,
  zReceiptList,
  zReverse,
  zSettingsPatch,
} from './accounts.validation.js';

const byId = { params: { id: zid } };
const anyAccountsRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.ACCOUNTS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};

/** /api/v1/accounts — settings and company bank accounts (B4.1). */
export const accountsRouter = Router();
accountsRouter.use(authenticate);

accountsRouter.get('/settings', anyAccountsRead, async (req, res) => {
  ok(res, accounts.toAccountSettings(await accounts.getAccountSettings(req.orgId)));
});

/**
 * Settings write: accounts:settings (admin) for everything; reminders:manage (managers) may
 * change the reminder rules alone (F6.3) — the rest of the accounts policy stays admin-only.
 */
const settingsWrite = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.ACCOUNTS_SETTINGS)) return next();
  const keys = Object.keys(req.body ?? {}).filter((k) => k !== 'version');
  if (p.has(P.REMINDERS_MANAGE) && keys.length > 0 && keys.every((k) => k === 'reminders')) {
    return next();
  }
  throw new ForbiddenError();
};

accountsRouter.patch(
  '/settings',
  settingsWrite,
  validate({ body: zSettingsPatch }),
  async (req, res) => {
    ok(
      res,
      await accounts.updateAccountSettings({
        orgId: req.orgId,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

accountsRouter.get(
  '/bank-accounts',
  anyAccountsRead,
  validate({ query: { active: z.enum(['true', 'false']).optional() } }),
  async (req, res) => {
    const { active } = req.valid.query;
    ok(
      res,
      await accounts.listBankAccounts(req.orgId, {
        active: active === undefined ? undefined : active === 'true',
      }),
    );
  },
);

accountsRouter.post(
  '/bank-accounts',
  authorize(P.ACCOUNTS_SETTINGS),
  validate({ body: zBankCreate }),
  async (req, res) => {
    created(
      res,
      await accounts.createBankAccount({
        orgId: req.orgId,
        input: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

accountsRouter.patch(
  '/bank-accounts/:id',
  authorize(P.ACCOUNTS_SETTINGS),
  validate({ ...byId, body: zBankPatch }),
  async (req, res) => {
    ok(
      res,
      await accounts.updateBankAccount({
        orgId: req.orgId,
        id: req.valid.params.id,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

/** /api/v1/receipts — the receipt register (B4.1). New receipts: POST /bookings/:id/receipts. */
export const receiptRouter = Router();
receiptRouter.use(authenticate);

const anyReceiptRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.BOOKINGS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};

receiptRouter.get('/', anyReceiptRead, validate({ query: zReceiptList }), async (req, res) => {
  const { items, meta } = await accounts.listReceipts(
    req.orgId,
    bookings.receiptScope(req.user),
    req.valid.query,
  );
  ok(res, items, { meta });
});

receiptRouter.get('/:id', anyReceiptRead, validate(byId), async (req, res) => {
  ok(res, await bookings.getVisibleReceipt(req.orgId, req.user, req.valid.params.id));
});

receiptRouter.post(
  '/:id/reverse',
  authorize(P.RECEIPTS_REVERSE),
  validate({ ...byId, body: zReverse }),
  async (req, res) => {
    ok(
      res,
      await bookings.reverseReceipt({
        org: req.org,
        user: req.user,
        receiptId: req.valid.params.id,
        reason: req.valid.body.reason,
        ctx: auditContext(req),
      }),
    );
  },
);
