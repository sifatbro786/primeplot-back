import { Router } from 'express';
import { P } from '#shared/auth/permissions.js';
import { idempotencyKey } from '#shared/middleware/idempotency.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { zAmount } from '#modules/accounts/accounts.validation.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as documents from '#modules/documents/document.service.js';
import * as payments from '#modules/payments/payment.service.js';
import { z } from 'zod';
import * as portal from './portal.service.js';
import {
  zDocQuery,
  zDuesQuery,
  zLocaleBody,
  zProfileRequest,
  zSlipCreate,
  zSlipList,
} from './portal.validation.js';

/**
 * /api/v1/portal — the customer portal API (B5.1/B5.2). Client logins only (`portal:access`);
 * staff use the dashboard endpoints. Everything is scoped to the signed-in client's customer.
 */
const router = Router();
router.use(authenticate, authorize(P.PORTAL_ACCESS));

const byId = { params: { id: zid } };
const ctxOf = (req) => ({ org: req.org, user: req.user, ctx: auditContext(req) });

router.get('/me', async (req, res) => {
  ok(res, await portal.getMe(req.org, req.user));
});

router.patch('/me', validate({ body: zLocaleBody }), async (req, res) => {
  await portal.setLocale({ ...ctxOf(req), locale: req.valid.body.locale });
  noContent(res);
});

router.get('/bookings', async (req, res) => {
  ok(res, await portal.listMyBookings(req.org, req.user));
});

router.get('/bookings/:id', validate(byId), async (req, res) => {
  ok(res, await portal.getMyBooking(req.org, req.user, req.valid.params.id));
});

router.get('/dues', validate({ query: zDuesQuery }), async (req, res) => {
  ok(res, await portal.myDues(req.org, req.user, req.valid.query));
});

// ── Documents (valid ones of my bookings) ───────────────────────────────────────

router.get('/documents/:id/html', validate({ ...byId, query: zDocQuery }), async (req, res) => {
  const d = await portal.myDocument(req.orgId, req.user, req.valid.params.id);
  const html = await documents.renderHtml(req.orgId, d, req.valid.query.locale);
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; frame-ancestors 'self'",
    })
    .send(html);
});

router.get('/documents/:id/pdf', validate({ ...byId, query: zDocQuery }), async (req, res) => {
  const d = await portal.myDocument(req.orgId, req.user, req.valid.params.id);
  const locale = req.valid.query.locale ?? d.locale;
  const pdf = await documents.getPdf(req.orgId, d, locale);
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${req.valid.query.download === '1' ? 'attachment' : 'inline'}; filename="${documents.pdfFilename(d, locale)}"`,
    })
    .send(pdf);
});

// ── Bank slips (D5) ─────────────────────────────────────────────────────────────

router.post(
  '/bookings/:id/slips',
  limits.upload,
  validate({ ...byId, body: zSlipCreate }),
  async (req, res) => {
    created(
      res,
      await portal.submitSlip({
        ...ctxOf(req),
        bookingId: req.valid.params.id,
        input: req.valid.body,
      }),
    );
  },
);

router.get('/slips', validate({ query: zSlipList }), async (req, res) => {
  const { items, meta } = await portal.listMySlips(req.org, req.user, req.valid.query);
  ok(res, items, { meta });
});

router.post('/slips/:id/withdraw', validate(byId), async (req, res) => {
  ok(res, await portal.withdrawSlip({ ...ctxOf(req), id: req.valid.params.id }));
});

// ── Contact-detail change requests ──────────────────────────────────────────────

router.get('/profile-requests', async (req, res) => {
  ok(res, await portal.listMyProfileRequests(req.org, req.user));
});

router.post(
  '/profile-requests',
  limits.sensitive,
  validate({ body: zProfileRequest }),
  async (req, res) => {
    created(res, await portal.submitProfileRequest({ ...ctxOf(req), input: req.valid.body }));
  },
);

router.post('/profile-requests/:id/withdraw', validate(byId), async (req, res) => {
  ok(res, await portal.withdrawProfileRequest({ ...ctxOf(req), id: req.valid.params.id }));
});

// ── Online payment (SSLCommerz, B5.2) ───────────────────────────────────────────

router.post(
  '/bookings/:id/pay',
  limits.sensitive,
  idempotencyKey,
  validate({ ...byId, body: z.object({ amount: zAmount }).strict() }),
  async (req, res) => {
    const r = await payments.startPayment({
      ...ctxOf(req),
      bookingId: req.valid.params.id,
      amount: req.valid.body.amount,
      idempotencyKey: req.idempotencyKey,
    });
    const body = { payment: r.payment, redirectUrl: r.redirectUrl };
    if (r.replayed) ok(res, body, { meta: { replayed: true } });
    else created(res, body);
  },
);

router.get('/payments', validate({ query: cursorQuery }), async (req, res) => {
  const { items, meta } = await payments.listMyPayments(req.org, req.user, req.valid.query);
  ok(res, items, { meta });
});

router.get('/payments/:id', validate(byId), async (req, res) => {
  ok(res, await payments.getMyPayment(req.org, req.user, req.valid.params.id));
});

export default router;
