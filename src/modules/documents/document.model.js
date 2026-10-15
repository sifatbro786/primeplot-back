import mongoose from 'mongoose';
import { AppError } from '#shared/errors/AppError.js';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const DOCUMENT_TYPES = Object.freeze([
  'receipt',
  'booking_form',
  'allotment_letter',
  'statement',
  'cancellation_letter',
  'transfer_letter',
  'cheque_ack',
]);

/**
 * QR-verifiable document (ARCHITECTURE §6.6, B4.3). The `snapshot` is everything the template
 * prints, frozen at issue time; `contentHash` = SHA-256 of the canonical JSON of
 * { type, number, snapshot }. The page and the PDF are rendered from the snapshot only, so a
 * later edit to a customer or project never changes an issued document.
 *
 * Only `status: valid → void` (+ reason, who, the replacement) and the cached PDFs may change.
 * One VALID document per (type, refId); voiding one allows a fresh issue (e.g. after transfer).
 */
const pdfSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    bytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    generatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const documentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: DOCUMENT_TYPES, required: true },
    number: { type: String, required: true, maxlength: 60 },
    refId: { type: ObjectId, default: null }, // receipt / cheque / booking (null for statements)
    bookingId: { type: ObjectId, ref: 'Booking', required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    soldBy: { type: ObjectId, ref: 'User', default: null }, // visibility, like receipts
    locale: { type: String, enum: ['bn', 'en'], default: 'bn' }, // customer's language
    verifyToken: { type: String, required: true },
    contentHash: { type: String, required: true },
    snapshot: { type: Mixed, required: true },
    status: { type: String, enum: ['valid', 'void'], default: 'valid' },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, maxlength: 300, default: null },
    // Set when staff voided it by hand (system voids — reversal, transfer … — leave it null).
    voidedBy: { type: ObjectId, ref: 'User', default: null },
    voidedByName: { type: String, maxlength: 120, default: null },
    // The corrected copy issued in its place (manual void), if any.
    replacedBy: { type: ObjectId, ref: 'Document', default: null },
    issuedBy: { type: ObjectId, ref: 'User', default: null },
    issuedByName: { type: String, maxlength: 120, default: null },
    pdf: {
      bn: { type: pdfSchema, default: null },
      en: { type: pdfSchema, default: null },
    },
  },
  { collection: 'documents', minimize: false },
);

documentSchema.plugin(baseSchema, { softDelete: false });
documentSchema.index({ verifyToken: 1 }, { unique: true }); // public lookup across orgs
documentSchema.index(
  { orgId: 1, type: 1, refId: 1 },
  { unique: true, partialFilterExpression: { status: 'valid', refId: { $type: 'objectId' } } },
);
documentSchema.index({ orgId: 1, bookingId: 1, createdAt: -1 });

const MUTABLE = new Set([
  'status',
  'voidedAt',
  'voidReason',
  'voidedBy',
  'voidedByName',
  'replacedBy',
  'pdf',
  'updatedAt',
]);
const immutable = (what) =>
  new AppError(`Issued documents are immutable (${what})`, {
    statusCode: 500,
    code: 'DOCUMENT_IMMUTABLE',
  });

documentSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function guard() {
  const u = this.getUpdate() ?? {};
  for (const [op, fields] of Object.entries(u)) {
    if (!op.startsWith('$')) throw immutable('replacement');
    if (op === '$setOnInsert') continue;
    if (op !== '$set') throw immutable(op);
    for (const k of Object.keys(fields)) if (!MUTABLE.has(k.split('.')[0])) throw immutable(k);
  }
});
documentSchema.pre(
  ['replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function blocked() {
    throw immutable(this.op);
  },
);

export const Document = mongoose.model('Document', documentSchema);
