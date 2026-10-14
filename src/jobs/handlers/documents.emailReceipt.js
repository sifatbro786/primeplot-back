import { sendEmail } from '#integrations/email/index.js';
import { renderEmail } from '#integrations/email/templates.js';
import { formatTaka } from '#shared/utils/money.js';
import {
  findDocumentById,
  getPdf,
  pdfFilename,
  verifyUrlOf,
} from '#modules/documents/document.service.js';
import { defineJob, PermanentJobError } from '../registry.js';

/**
 * B4.3 (owner decision Q8): the money receipt e-mail with its PDF. Prints the PDF if it isn't
 * cached yet. A void receipt (reversed meanwhile) is not sent.
 */
defineJob({
  type: 'documents.emailReceipt',
  maxAttempts: 5,
  timeoutMs: 120_000,
  async handler({ documentId, to }, { orgId }) {
    const doc = await findDocumentById(orgId, documentId);
    if (!doc || doc.type !== 'receipt') throw new PermanentJobError('Receipt document not found');
    if (doc.status !== 'valid') return { skipped: 'void' };
    const s = doc.snapshot;
    const bn = doc.locale === 'bn';
    const msg = renderEmail('receipt', doc.locale, {
      orgName: (bn && s.org.nameBn) || s.org.name,
      name: (bn && s.holder.nameBn) || s.holder.name,
      amount: formatTaka(s.receipt.amount, { decimals: s.receipt.amount % 100 !== 0 }),
      date: s.receipt.date,
      receiptNo: s.receipt.receiptNo,
      bookingNo: s.booking.bookingNo,
      unit: s.unit.code,
      project: (bn && s.project.nameBn) || s.project.name,
      verifyUrl: verifyUrlOf(doc.verifyToken),
    });
    const pdf = await getPdf(orgId, doc, doc.locale);
    return sendEmail(orgId, {
      to,
      ...msg,
      attachments: [
        { filename: pdfFilename(doc, doc.locale), content: pdf, contentType: 'application/pdf' },
      ],
    });
  },
});
