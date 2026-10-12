import { z } from 'zod';
import { env } from '#config/env.js';
import { zid } from '#shared/middleware/validate.js';
import {
  zLandAreaInput,
  zMoney,
  zSignedMoney,
  zSqft,
  zText,
  zVersion,
} from '#modules/projects/project.validation.js';
import { FACINGS } from './pricing.js';
import { BLOCK_REASONS } from './unitStatus.js';

/**
 * Unit request schemas. One strict shape for both kinds; the service rejects fields that
 * belong to the other kind (FIELD_NOT_ALLOWED) because the kind comes from the project.
 */
const optText = (max) => zText(max).nullable().optional();
const count = z.number().int().min(0).max(20);

export const APARTMENT_FIELDS = Object.freeze([
  'floor',
  'position',
  'typeLabel',
  'bedrooms',
  'bathrooms',
  'balconies',
  'saleableSqft',
  'carpetSqft',
  'parkingSlots',
]);
export const PLOT_FIELDS = Object.freeze([
  'plotNo',
  'road',
  'roadWidthFt',
  'landArea',
  'dimensions',
]);
export const PRICE_FIELDS = Object.freeze(['rateOverride', 'priceAdjustment']);

const dim = z.number().positive().max(10_000).nullable().optional();

const unitFields = {
  code: zText(40).min(1),
  blockId: zid,
  // apartment
  floor: z.number().int().min(-5).max(200),
  position: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, 'Use letters/digits, e.g. A, B2')
    .nullable(),
  typeLabel: optText(60),
  bedrooms: count.nullable(),
  bathrooms: count.nullable(),
  balconies: count.nullable(),
  saleableSqft: zSqft.nullable(),
  carpetSqft: zSqft.nullable(),
  parkingSlots: z.number().int().min(0).max(10),
  // plot
  plotNo: optText(20),
  road: optText(60),
  roadWidthFt: z.number().min(0).max(500).nullable(),
  landArea: zLandAreaInput.nullable(),
  dimensions: z
    .object({ frontFt: dim, backFt: dim, leftFt: dim, rightFt: dim })
    .strict()
    .nullable(),
  // both
  facing: z.enum(FACINGS).nullable(),
  isCorner: z.boolean(),
  features: z
    .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
    .max(30)
    .refine((a) => new Set(a).size === a.length, 'Duplicate feature'),
  layoutMediaId: zid.nullable(),
  sortOrder: z.number().int().min(-100_000).max(100_000),
  // price (needs pricing:write)
  rateOverride: zMoney.nullable(),
  priceAdjustment: z
    .object({ amount: zSignedMoney, note: zText(200).optional() })
    .strict()
    .nullable(),
};

const optionalAll = (shape) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]));

/** `code` is optional: generated from block + floor + position (apartment) or plot number. */
export const zUnitCreate = z
  .object({ ...optionalAll(unitFields), blockId: unitFields.blockId })
  .strict();

export const zUnitPatch = z
  .object({ ...optionalAll(unitFields), version: zVersion })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

export const zUnitBulk = z.object({ units: z.array(zUnitCreate).min(1).max(500) }).strict();

export const zUnitListQuery = {
  blockId: zid.optional(),
  floor: z.coerce.number().int().min(-5).max(200).optional(),
  status: z
    .enum([
      'available',
      'held',
      'booked',
      'allotted',
      'registered',
      'handed_over',
      'cancelled',
      'blocked',
      'sold',
    ])
    .optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  q: z.string().trim().min(1).max(40).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  // The inventory grid loads a whole building at once.
  limit: z.coerce.number().int().min(1).max(1000).default(500),
};

export const zHold = z
  .object({
    hours: z.number().int().min(1).max(env.UNIT_HOLD_MAX_HOURS).optional(),
    note: zText(300).optional(),
    leadId: zid.optional(),
  })
  .strict();

export const zExtendHold = z
  .object({ hours: z.number().int().min(1).max(env.UNIT_HOLD_MAX_HOURS) })
  .strict();

export const zBlockUnit = z
  .object({ reason: z.enum(BLOCK_REASONS), note: zText(300).optional() })
  .strict()
  .refine((b) => b.reason !== 'other' || (b.note && b.note.length >= 3), {
    message: 'A note is required when the reason is "other"',
    path: ['note'],
  });

export { zVersion };
