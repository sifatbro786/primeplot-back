import { z } from 'zod';
import { zemail, zid } from '#shared/middleware/validate.js';
import { offsetQuery } from '#shared/utils/pagination.js';

const text = (max) => z.string().trim().max(max);
const opt = (max) => text(max).nullable().optional();

/** Smart card NID: 10 digits; old NID: 13 or 17 digits. */
export const zNid = z
  .string()
  .trim()
  .regex(/^(\d{10}|\d{13}|\d{17})$/, 'NID is 10, 13 or 17 digits');

const fields = {
  name: text(160).min(2),
  nameBn: opt(160),
  fatherName: opt(160),
  motherName: opt(160),
  spouseName: opt(160),
  dateOfBirth: z.iso.date().nullable().optional(),
  nationality: opt(60),
  nid: zNid.nullable().optional(),
  passportNo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,12}$/, '6–12 letters/digits')
    .nullable()
    .optional(),
  tin: z
    .string()
    .trim()
    .regex(/^\d{12}$/, 'TIN is 12 digits')
    .nullable()
    .optional(),
  phone: text(30).min(6), // normalized (BD or international E.164) in the service
  altPhone: text(30).nullable().optional(),
  email: zemail.nullable().optional(),
  presentAddress: opt(500),
  permanentAddress: opt(500),
  foreignAddress: opt(500),
  occupation: opt(120),
  organization: opt(160),
  locale: z.enum(['bn', 'en']).nullable().optional(),
  photoMediaId: zid.nullable().optional(),
  documentMediaIds: z
    .array(zid)
    .max(10)
    .refine((a) => new Set(a).size === a.length, 'Duplicate file')
    .optional(),
  leadId: zid.nullable().optional(),
  notes: opt(1000),
};

export const zCustomerCreate = z.object(fields).strict();

export const zCustomerPatch = z
  .object({
    ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])),
    version: z.number().int().min(0),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

export const zCustomerList = {
  q: z.string().trim().min(1).max(100).optional(), // name, phone, NID, customer no.
  ...offsetQuery,
};
