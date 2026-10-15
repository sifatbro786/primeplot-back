import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { created, ok } from '#shared/utils/response.js';
import { authenticate, authorize, authorizeAny } from '#modules/auth/auth.middleware.js';
import { auditContext, audit } from '#modules/audit/audit.service.js';
import { getVisibleBooking } from '#modules/bookings/booking.service.js';
import * as reminders from './reminder.service.js';
import { REMINDER_KINDS, REMINDER_TEXT_MAX } from './reminderText.js';

/**
 * /api/v1/reminders — installment reminders (B5.3). Rules and the send hour live in accounts
 * settings (`PATCH /accounts/settings` → `reminders`).
 */
export const reminderRouter = Router();
reminderRouter.use(authenticate);
const manage = authorize(P.REMINDERS_MANAGE);

reminderRouter.get(
  '/log',
  authorizeAny(P.REMINDERS_MANAGE, P.REPORTS_READ),
  validate({
    query: {
      bookingId: zid.optional(),
      rule: z
        .string()
        .regex(/^[a-z0-9_]{1,30}$/)
        .optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      ...cursorQuery,
    },
  }),
  async (req, res) => {
    const { items, meta } = await reminders.listReminderLog(req.orgId, req.valid.query);
    ok(res, items, { meta });
  },
);

/** What today's run would send (nothing is sent). */
reminderRouter.get('/preview', manage, async (req, res) => {
  ok(res, await reminders.runReminders(req.orgId, { dryRun: true }));
});

/**
 * Live length/cost of a reminder text for the dashboard editor (nothing is sent). Empty text →
 * the built-in one. Same people who may edit the texts (managers or accounts settings).
 */
reminderRouter.post(
  '/sms-preview',
  authorizeAny(P.REMINDERS_MANAGE, P.ACCOUNTS_SETTINGS),
  validate({
    body: z
      .object({
        kind: z.enum(REMINDER_KINDS),
        locale: z.enum(['bn', 'en']),
        text: z.string().max(REMINDER_TEXT_MAX).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    ok(res, reminders.previewReminderSms(req.org, req.valid.body));
  },
);

/** Run now, ignoring the send hour (still once per booking/rule/due date). */
reminderRouter.post('/run', manage, async (req, res) => {
  const result = await reminders.runReminders(req.orgId, { force: true });
  await audit(auditContext(req), 'reminder.run', { meta: result });
  ok(res, result);
});

/** /api/v1/bookings/:id/remind — "send a reminder now" from the booking page. */
export const bookingRemindRouter = Router();
bookingRemindRouter.use(authenticate);

bookingRemindRouter.post(
  '/:id/remind',
  authorizeAny(P.REMINDERS_MANAGE, P.RECEIPTS_CREATE),
  validate({ params: { id: zid } }),
  async (req, res) => {
    const booking = await getVisibleBooking(req.orgId, req.user, req.valid.params.id);
    created(
      res,
      await reminders.remindNow({ org: req.org, user: req.user, booking, ctx: auditContext(req) }),
    );
  },
);
