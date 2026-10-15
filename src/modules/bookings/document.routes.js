import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { ConflictError, ForbiddenError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext, audit } from '#modules/audit/audit.service.js';
import * as documents from '#modules/documents/document.service.js';
import { Booking } from './booking.model.js';
import { getVisibleBooking } from './booking.service.js';
import * as docs from './documentData.js';

/**
 * Documents (B4.3). Staff routes live here (bookings decides who may see which booking);
 * the document module itself only stores, renders and verifies.
 */
const anyRead = (req, res, next) => {
  const p = req.user.permissions;
  if (p.has(P.BOOKINGS_READ) || p.has(P.BOOKINGS_READ_ALL)) return next();
  throw new ForbiddenError();
};
const byId = { params: { id: zid } };
const zLocale = {
  locale: z.enum(['bn', 'en']).optional(),
  download: z.enum(['1', '0']).optional(),
};

/** /api/v1/bookings/:id/documents, /api/v1/bookings/:id/statement */
export const bookingDocuments = Router();
bookingDocuments.use(authenticate);

bookingDocuments.get('/:id/documents', anyRead, validate(byId), async (req, res) => {
  const b = await getVisibleBooking(req.orgId, req.user, req.valid.params.id);
  await docs.backfillDocuments(req.org, b);
  ok(res, await documents.listBookingDocuments(req.orgId, b._id));
});

bookingDocuments.post(
  '/:id/statement',
  authorize(P.DOCUMENTS_ISSUE),
  validate(byId),
  async (req, res) => {
    const b = await getVisibleBooking(req.orgId, req.user, req.valid.params.id);
    const doc = await docs.issueStatement(req.org, b, req.user);
    await audit(auditContext(req), 'document.issue', {
      entity: { type: 'Document', id: doc._id },
      meta: { type: 'statement', number: doc.number },
    });
    created(res, documents.toDocument(doc));
  },
);

/** /api/v1/documents/:id … */
export const documentRouter = Router();
documentRouter.use(authenticate);

documentRouter.get('/:id', anyRead, validate(byId), async (req, res) => {
  ok(
    res,
    documents.toDocument(
      await documents.getVisibleDocument(req.orgId, req.user, req.valid.params.id),
    ),
  );
});

/**
 * Void an issued paper by hand (admin, `documents:void`) — wrong details went out. The QR check
 * then says "cancelled" with the reason. Fix the record first (customer, booking …): a corrected
 * copy is issued right away from today's data when that paper still applies (not statements).
 * Receipts keep their money — only the paper is replaced; reverse the receipt to undo money.
 */
documentRouter.post(
  '/:id/void',
  authorize(P.DOCUMENTS_VOID),
  validate({ ...byId, body: z.object({ reason: z.string().trim().min(5).max(300) }).strict() }),
  async (req, res) => {
    const d = await documents.getVisibleDocument(req.orgId, req.user, req.valid.params.id);
    if (d.status !== 'valid') {
      throw new ConflictError('This document is already void', { code: 'DOCUMENT_ALREADY_VOID' });
    }
    const { reason } = req.valid.body;
    let voided = await documents.voidDocument({
      orgId: req.orgId,
      id: d._id,
      reason,
      user: req.user,
    });
    const booking = await Booking.findOne({ orgId: req.orgId, _id: d.bookingId }).lean();
    const reissued = booking
      ? await docs.safely('reissue after void', () =>
          docs.reissueDocument(req.org, booking, voided, req.user),
        )
      : null;
    if (reissued) {
      await documents.markReplaced(req.orgId, voided._id, reissued._id);
      voided = { ...voided, replacedBy: reissued._id };
    }
    await audit(auditContext(req), 'document.void', {
      entity: { type: 'Document', id: d._id },
      meta: {
        type: d.type,
        number: d.number,
        reason,
        bookingId: String(d.bookingId),
        reissuedId: reissued ? String(reissued._id) : null,
      },
    });
    ok(res, {
      document: documents.toDocument(voided),
      reissued: reissued ? documents.toDocument(reissued) : null,
    });
  },
);

/** The A4 page (print preview). Self-contained HTML: fonts, QR and logo inlined. */
documentRouter.get(
  '/:id/html',
  anyRead,
  validate({ ...byId, query: zLocale }),
  async (req, res) => {
    const d = await documents.getVisibleDocument(req.orgId, req.user, req.valid.params.id);
    const html = await documents.renderHtml(req.orgId, d, req.valid.query.locale);
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        // The page has no scripts; it is shown inside the dashboard (iframe, same origin).
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; frame-ancestors 'self'",
      })
      .send(html);
  },
);

documentRouter.get('/:id/pdf', anyRead, validate({ ...byId, query: zLocale }), async (req, res) => {
  const d = await documents.getVisibleDocument(req.orgId, req.user, req.valid.params.id);
  const locale = req.valid.query.locale ?? d.locale;
  const pdf = await documents.getPdf(req.orgId, d, locale);
  const name = documents.pdfFilename(d, locale);
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${req.valid.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`,
    })
    .send(pdf);
});

/** /api/v1/public/verify/:token — the QR code lands here (via the website's /verify page). */
export const verifyRouter = Router();
verifyRouter.get(
  '/:token',
  validate({ params: { token: z.string().max(60) } }),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    ok(res, await documents.verifyPublic(req.orgId, req.valid.params.token));
  },
);
