import mongoose from 'mongoose';
import { P } from '#shared/auth/permissions.js';
import { BadRequestError, ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { parseDhakaDate, toDhakaDate } from '#shared/utils/dhakaDate.js';
import { offsetMeta } from '#shared/utils/pagination.js';
import { normalizePhone } from '#shared/utils/phone.js';
import { audit } from '#modules/audit/audit.service.js';
import { assertPrivateMedia } from '#modules/media/media.service.js';
import { getVisibleLead } from '#modules/leads/lead.service.js';
import { ensureCounter, nextSeq } from '#modules/accounts/counter.model.js';
import { syncPortalLogin } from '#modules/portal/portalAccount.service.js';
import { Customer } from './customer.model.js';

/**
 * Customers (B4). Staff without bookings:read_all see only customers they created or that are
 * on a booking they sold (`accessUserIds`); anything else is a 404 so ids can't be probed.
 */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const idOrNull = (v) => (v ? String(v) : null);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const staleVersion = () =>
  new ConflictError('This customer was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

export const canReadAllCustomers = (user) => user.permissions.has(P.BOOKINGS_READ_ALL);
export const customerScope = (user) =>
  canReadAllCustomers(user) ? {} : { accessUserIds: oid(user.id) };

export function toCustomer(c) {
  return {
    id: String(c._id),
    customerNo: c.customerNo,
    name: c.name,
    nameBn: c.nameBn ?? null,
    fatherName: c.fatherName ?? null,
    motherName: c.motherName ?? null,
    spouseName: c.spouseName ?? null,
    dateOfBirth: c.dateOfBirth ? toDhakaDate(c.dateOfBirth) : null,
    nationality: c.nationality ?? null,
    nid: c.nid ?? null,
    passportNo: c.passportNo ?? null,
    tin: c.tin ?? null,
    phone: c.phone,
    altPhone: c.altPhone ?? null,
    email: c.email ?? null,
    presentAddress: c.presentAddress ?? null,
    permanentAddress: c.permanentAddress ?? null,
    foreignAddress: c.foreignAddress ?? null,
    occupation: c.occupation ?? null,
    organization: c.organization ?? null,
    locale: c.locale ?? null,
    photoMediaId: idOrNull(c.photoMediaId),
    documentMediaIds: (c.documentMediaIds ?? []).map(String),
    leadId: idOrNull(c.leadId),
    notes: c.notes ?? null,
    hasPortalAccount: Boolean(c.portalUserId),
    version: c.__v ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The short card shown on bookings and receipts. */
export function toCustomerRef(c) {
  return {
    id: String(c._id),
    customerNo: c.customerNo,
    name: c.name,
    nameBn: c.nameBn ?? null,
    phone: c.phone,
  };
}

function phoneOrThrow(input, path) {
  const e164 = normalizePhone(input);
  if (!e164) {
    throw new BadRequestError('Invalid phone number', {
      code: 'INVALID_PHONE',
      details: [
        {
          path,
          message: 'Enter a Bangladesh mobile or an international number with +country code',
        },
      ],
    });
  }
  return e164;
}

async function normalizeInput(orgId, user, input) {
  const out = { ...input };
  if (input.phone !== undefined) out.phone = phoneOrThrow(input.phone, 'phone');
  if (input.altPhone) out.altPhone = phoneOrThrow(input.altPhone, 'altPhone');
  if (input.dateOfBirth !== undefined) {
    out.dateOfBirth = input.dateOfBirth ? parseDhakaDate(input.dateOfBirth) : null;
  }
  if (input.passportNo) out.passportNo = input.passportNo.toUpperCase();
  const media = [input.photoMediaId, ...(input.documentMediaIds ?? [])].filter(Boolean);
  if (media.length) await assertPrivateMedia(orgId, media);
  if (input.leadId) await getVisibleLead(orgId, user, input.leadId); // 404 if not theirs
  return out;
}

export async function createCustomer({ orgId, user, input, ctx }) {
  const data = await normalizeInput(orgId, user, input);
  await ensureCounter(orgId, 'customer');
  const seq = await nextSeq(orgId, 'customer', {});
  const doc = await Customer.create({
    ...data,
    orgId,
    customerNo: `C-${String(seq).padStart(6, '0')}`,
    accessUserIds: [oid(user.id)],
    createdBy: oid(user.id),
  });
  await audit(ctx, 'customer.create', {
    entity: { type: 'Customer', id: doc._id },
    meta: { customerNo: doc.customerNo, name: doc.name },
  });
  return toCustomer(doc.toObject());
}

export async function listCustomers(orgId, user, { q, page, limit }) {
  const filter = { orgId, ...customerScope(user) };
  if (q) {
    const phone = normalizePhone(q);
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    filter.$or = [
      { name: rx },
      { nameBn: rx },
      { customerNo: { $regex: `^${escapeRegex(q.toUpperCase())}` } },
      { nid: q },
      { passportNo: q.toUpperCase() },
      ...(phone ? [{ phone }, { altPhone: phone }] : []),
    ];
  }
  const [rows, total] = await Promise.all([
    Customer.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Customer.countDocuments(filter),
  ]);
  return { items: rows.map(toCustomer), meta: offsetMeta({ page, limit }, total) };
}

/** A customer this user may see (lean), or 404. */
export async function getVisibleCustomer(orgId, user, id, { session } = {}) {
  const c = await Customer.findOne({ orgId, _id: id, ...customerScope(user) })
    .session(session ?? null)
    .lean();
  if (!c) throw new NotFoundError('Customer not found');
  return c;
}

const AUDITED = [
  'name',
  'nameBn',
  'fatherName',
  'motherName',
  'spouseName',
  'dateOfBirth',
  'nationality',
  'nid',
  'passportNo',
  'tin',
  'phone',
  'altPhone',
  'email',
  'presentAddress',
  'permanentAddress',
  'foreignAddress',
  'occupation',
  'organization',
  'locale',
  'photoMediaId',
  'documentMediaIds',
  'leadId',
  'notes',
];

export async function updateCustomer({ orgId, user, id, patch, ctx }) {
  await getVisibleCustomer(orgId, user, id);
  const doc = await Customer.findOne({ orgId, _id: id });
  if (doc.__v !== patch.version) throw staleVersion();
  const { version: _v, ...input } = patch;
  const data = await normalizeInput(orgId, user, input);
  const before = doc.toObject();
  for (const [k, v] of Object.entries(data)) doc.set(k, v);
  await doc.save();
  const diff = diffFields(before, doc.toObject(), AUDITED);
  if (diff)
    await audit(ctx, 'customer.update', { entity: { type: 'Customer', id: doc._id }, diff });
  // B5: the portal login signs in with this phone / e-mail and greets by this name.
  if (['name', 'phone', 'email', 'locale'].some((k) => data[k] !== undefined)) {
    await syncPortalLogin(orgId, doc.toObject());
  }
  return toCustomer(doc.toObject());
}

// ── For the bookings module ─────────────────────────────────────────────────────

/** Lean customers by id (deleted included — documents keep their names). */
export async function customersByIds(orgId, ids, { session } = {}) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await Customer.find({ orgId, _id: { $in: unique } })
    .setOptions({ withDeleted: true })
    .session(session ?? null)
    .lean();
  return new Map(rows.map((c) => [String(c._id), c]));
}

/** The seller of a booking may see its customers from now on (inside the booking transaction). */
export async function grantAccess(orgId, customerIds, userId, { session }) {
  await Customer.updateMany(
    { orgId, _id: { $in: customerIds.map(oid) } },
    { $addToSet: { accessUserIds: oid(userId) } },
    { session },
  );
}
