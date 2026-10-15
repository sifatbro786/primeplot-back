import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import QRCode from 'qrcode';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import { ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { storage } from '#integrations/storage/index.js';
import { mediaDataUri } from '#modules/media/media.service.js';
import { Document } from './document.model.js';
import { htmlToPdf } from './pdf.js';
import { mainDate, renderDocumentHtml } from './render/templates.js';

/**
 * QR-verified documents (B4.3, ARCHITECTURE §6.6). Generic on purpose: the bookings module
 * builds each snapshot and calls issueDocument(); this module stores, renders, prints and
 * verifies — it never reads another module's records (one-way dependency bookings → documents).
 */
const log = logger.child({ module: 'documents' });
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

/** JSON with sorted keys — the same snapshot always hashes the same. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function contentHashOf({ type, number, snapshot }) {
  return createHash('sha256').update(canonicalJson({ type, number, snapshot })).digest('hex');
}

export const verifyUrlOf = (token) => `${env.siteUrl}/verify/${token}`;

export function toDocument(d) {
  return {
    id: String(d._id),
    type: d.type,
    number: d.number,
    bookingId: String(d.bookingId),
    refId: d.refId ? String(d.refId) : null,
    locale: d.locale,
    date: mainDate(d.type, d.snapshot),
    status: d.status,
    voidReason: d.voidReason ?? null,
    voidedAt: d.voidedAt ?? null,
    voidedBy: d.voidedBy ? { id: String(d.voidedBy), name: d.voidedByName ?? null } : null,
    replacedBy: d.replacedBy ? String(d.replacedBy) : null,
    verifyUrl: verifyUrlOf(d.verifyToken),
    contentHash: d.contentHash,
    issuedBy: d.issuedBy ? { id: String(d.issuedBy), name: d.issuedByName ?? null } : null,
    createdAt: d.createdAt,
  };
}

/**
 * Issue a document. Idempotent per (type, refId): if a valid one exists it is returned as is.
 * `booking` needs { _id, projectId, soldBy }.
 */
export async function issueDocument({
  orgId,
  type,
  number,
  refId,
  booking,
  locale,
  snapshot,
  user,
}) {
  if (refId) {
    const existing = await Document.findOne({ orgId, type, refId, status: 'valid' }).lean();
    if (existing) return existing;
  }
  const doc = {
    orgId,
    type,
    number,
    refId: refId ? oid(refId) : null,
    bookingId: booking._id,
    projectId: booking.projectId,
    soldBy: booking.soldBy ?? null,
    locale: locale === 'en' ? 'en' : 'bn',
    verifyToken: randomBytes(18).toString('base64url'),
    contentHash: contentHashOf({ type, number, snapshot }),
    snapshot,
    issuedBy: user ? oid(user.id) : null,
    issuedByName: user?.name ?? null,
  };
  try {
    return (await Document.create(doc)).toObject();
  } catch (err) {
    if (err?.code === 11000 && refId) {
      const existing = await Document.findOne({ orgId, type, refId, status: 'valid' }).lean();
      if (existing) return existing;
    }
    throw err;
  }
}

/** Void every valid document matching `filter` (e.g. a reversed receipt). Returns the count. */
export async function voidDocuments(orgId, filter, reason) {
  const docs = await Document.find({ orgId, status: 'valid', ...filter })
    .select('pdf')
    .lean();
  if (!docs.length) return 0;
  await Document.updateMany(
    { orgId, _id: { $in: docs.map((d) => d._id) } },
    {
      $set: {
        status: 'void',
        voidedAt: new Date(),
        voidReason: reason,
        pdf: { bn: null, en: null },
      },
    },
  );
  for (const d of docs) await dropPdfs(d);
  return docs.length;
}

/** Cached PDFs were printed without the VOID mark — drop them; the next print shows it. */
async function dropPdfs(d) {
  for (const p of [d.pdf?.bn, d.pdf?.en].filter(Boolean)) {
    await storage.remove({ key: p.key, visibility: 'private' }).catch(() => {});
  }
}

/**
 * Void ONE document by hand (staff, with a reason). 409 DOCUMENT_ALREADY_VOID when it is not
 * valid any more (also when two people void it at the same moment). Returns the voided doc.
 */
export async function voidDocument({ orgId, id, reason, user }) {
  const before = await Document.findOneAndUpdate(
    { orgId, _id: oid(id), status: 'valid' },
    {
      $set: {
        status: 'void',
        voidedAt: new Date(),
        voidReason: reason,
        voidedBy: oid(user.id),
        voidedByName: user.name ?? null,
        pdf: { bn: null, en: null },
      },
    },
    { returnDocument: 'before', lean: true },
  );
  if (!before) {
    throw new ConflictError('This document is already void', { code: 'DOCUMENT_ALREADY_VOID' });
  }
  await dropPdfs(before);
  return Document.findOne({ orgId, _id: before._id }).lean();
}

/** Point a voided document at the corrected copy issued in its place. */
export async function markReplaced(orgId, id, replacementId) {
  await Document.updateOne(
    { orgId, _id: oid(id), status: 'void' },
    { $set: { replacedBy: oid(replacementId) } },
  );
}

export function findDocumentById(orgId, id) {
  return Document.findOne({ orgId, _id: id }).lean();
}

export function findValidDocument(orgId, type, refId) {
  return Document.findOne({ orgId, type, refId: oid(refId), status: 'valid' }).lean();
}

export async function listBookingDocuments(orgId, bookingId) {
  const rows = await Document.find({ orgId, bookingId: oid(bookingId) })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  return rows.map(toDocument);
}

/** A document this user may open (seller scope without bookings:read_all), or 404. */
export async function getVisibleDocument(orgId, user, id) {
  const d = await Document.findOne({ orgId, _id: id }).lean();
  if (!d) throw new NotFoundError('Document not found');
  if (!user.permissions.has(P.BOOKINGS_READ_ALL) && String(d.soldBy) !== user.id) {
    throw new NotFoundError('Document not found');
  }
  return d;
}

// ── Rendering ───────────────────────────────────────────────────────────────────

const logoCache = new Map(); // mediaId → { uri, at }
const LOGO_TTL = 10 * 60_000;

async function logoOf(orgId, mediaId) {
  if (!mediaId) return null;
  const hit = logoCache.get(String(mediaId));
  if (hit && Date.now() - hit.at < LOGO_TTL) return hit.uri;
  const uri = await mediaDataUri(orgId, mediaId, 'card').catch(() => null);
  logoCache.set(String(mediaId), { uri, at: Date.now() });
  return uri;
}

export async function renderHtml(orgId, doc, locale) {
  const verifyUrl = verifyUrlOf(doc.verifyToken);
  const qrSvg = await QRCode.toString(verifyUrl, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#1C1D1A', light: '#0000' },
  });
  return renderDocumentHtml({
    doc,
    locale: locale ?? doc.locale,
    logo: await logoOf(orgId, doc.snapshot.org?.logoMediaId),
    verifyUrl,
    qrSvg,
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * PDF of a document. Valid documents are printed once per language and kept in private
 * storage; void documents are printed fresh (with the VOID mark) and not kept.
 */
export async function getPdf(orgId, doc, locale) {
  const lang = (locale ?? doc.locale) === 'en' ? 'en' : 'bn';
  const cached = doc.status === 'valid' ? doc.pdf?.[lang] : null;
  if (cached) {
    const exists = await storage.stat({ key: cached.key, visibility: 'private' });
    if (exists)
      return readAll(storage.createReadStream({ key: cached.key, visibility: 'private' }));
  }
  const pdf = await htmlToPdf(await renderHtml(orgId, doc, lang));
  if (doc.status === 'valid') {
    const d = doc.createdAt ? new Date(doc.createdAt) : new Date();
    const key = `documents/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${doc._id}-${lang}.pdf`;
    try {
      await storage.put({ key, body: pdf, visibility: 'private' });
      await Document.updateOne(
        { orgId, _id: doc._id, status: 'valid' },
        {
          $set: {
            [`pdf.${lang}`]: {
              key,
              bytes: pdf.length,
              sha256: createHash('sha256').update(pdf).digest('hex'),
              generatedAt: new Date(),
            },
          },
        },
      );
    } catch (err) {
      log.warn({ err: { message: err.message }, id: String(doc._id) }, 'PDF cache write failed');
    }
  }
  return pdf;
}

export function pdfFilename(doc, locale) {
  const safe = doc.number.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `${doc.type.replace(/_/g, '-')}-${safe}${locale === 'en' ? '' : '-bn'}.pdf`;
}

// ── Public verification ─────────────────────────────────────────────────────────

/** "Abdur Rahim" → "A**** R****" — enough to recognise, not enough to harvest. */
export function maskName(name) {
  return String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const chars = [...w];
      return chars[0] + '*'.repeat(Math.max(2, chars.length - 1));
    })
    .join(' ');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;

/** GET /public/verify/:token — what a stranger holding the paper may see. */
export async function verifyPublic(orgId, token) {
  if (!TOKEN_RE.test(token)) throw new NotFoundError('Document not found');
  const d = await Document.findOne({ orgId, verifyToken: token }).lean();
  if (!d) throw new NotFoundError('Document not found');
  const s = d.snapshot;
  const amount =
    d.type === 'receipt'
      ? s.receipt.amount
      : d.type === 'cheque_ack'
        ? s.cheque.amount
        : d.type === 'booking_form'
          ? s.price.contractTotal
          : d.type === 'cancellation_letter'
            ? s.cancellation.refundable
            : null;
  return {
    valid: d.status === 'valid',
    status: d.status,
    voidReason: d.status === 'void' ? (d.voidReason ?? null) : null,
    // A corrected copy exists (its own QR) — the holder should have received it.
    replaced: d.status === 'void' && Boolean(d.replacedBy),
    type: d.type,
    number: d.number,
    date: mainDate(d.type, s),
    issuedAt: d.createdAt,
    organization: { name: s.org.name, nameBn: s.org.nameBn ?? null },
    project: { name: s.project.name, nameBn: s.project.nameBn ?? null },
    unitCode: s.unit.code,
    holder: maskName(s.holder.name),
    amount,
    fingerprint: d.contentHash.slice(0, 16),
  };
}
