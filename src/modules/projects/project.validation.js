import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { hasMaxDecimals, LAND_UNITS } from '#shared/utils/area.js';
import { FACINGS } from '#modules/units/pricing.js';
import { APPROVAL_AUTHORITIES, PROJECT_KINDS, PROJECT_STAGES } from './project.model.js';
import { BLOCK_KINDS } from './block.model.js';

/** Shared request schemas for B2 (projects, blocks, units, floor plans). Strict everywhere. */

const MAX_MONEY = 10_000_000_000_000; // ৳1,000 crore in poisha — far above any single unit
export const zMoney = z.number().int().min(0).max(MAX_MONEY);
export const zSignedMoney = z.number().int().min(-MAX_MONEY).max(MAX_MONEY);
export const zText = (max) => z.string().trim().max(max);
const optText = (max) => zText(max).nullable().optional();

export const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and dashes');

export const zVersion = z.number().int().min(0);

export const zLandAreaInput = z
  .object({
    value: z
      .number()
      .positive()
      .max(1_000_000)
      .refine((v) => hasMaxDecimals(v, 4), 'At most 4 decimal places'),
    unit: z.enum(LAND_UNITS),
  })
  .strict();

export const zSqft = z
  .number()
  .positive()
  .max(1_000_000)
  .refine((v) => hasMaxDecimals(v, 2), 'At most 2 decimal places');

const uniqueBy = (key) => (arr) => new Set(arr.map((x) => x[key])).size === arr.length;

const zCharges = z
  .array(
    z
      .object({
        code: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Use a-z, 0-9 and _'),
        label: zText(120).min(1),
        labelBn: zText(120).optional(),
        amount: zMoney,
      })
      .strict(),
  )
  .max(20)
  .refine(uniqueBy('code'), 'Duplicate charge code');

export const zApartmentPricing = z
  .object({
    ratePerSqft: zMoney.nullable().optional(),
    floorRise: z
      .object({ fromFloor: z.number().int().min(-5).max(200), perFloorPerSqft: zMoney })
      .strict()
      .nullable()
      .optional(),
    facingPremiums: z
      .array(z.object({ facing: z.enum(FACINGS), perSqft: zSignedMoney }).strict())
      .max(8)
      .refine(uniqueBy('facing'), 'Duplicate facing')
      .optional(),
    cornerPerSqft: zMoney.nullable().optional(),
    parkingPerSlot: zMoney.nullable().optional(),
    charges: zCharges.optional(),
  })
  .strict();

export const zPlotPricing = z
  .object({
    rateUnit: z.enum(LAND_UNITS),
    rate: zMoney.nullable().optional(),
    cornerPremiumBps: z.number().int().min(0).max(5000).nullable().optional(),
    roadWidthPremiums: z
      .array(z.object({ minWidthFt: z.number().min(0).max(500), perUnit: zSignedMoney }).strict())
      .max(10)
      .refine(uniqueBy('minWidthFt'), 'Duplicate road width tier')
      .optional(),
    facingPremiums: z
      .array(z.object({ facing: z.enum(FACINGS), perUnit: zSignedMoney }).strict())
      .max(8)
      .refine(uniqueBy('facing'), 'Duplicate facing')
      .optional(),
    charges: zCharges.optional(),
  })
  .strict();

const zLocation = z
  .object({
    address: optText(300),
    addressBn: optText(300),
    area: optText(100),
    areaBn: optText(100),
    city: optText(80),
    district: optText(80),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  })
  .strict()
  .refine((l) => (l.lat == null) === (l.lng == null), 'Give both lat and lng, or neither');

const projectFields = {
  name: zText(160).min(2),
  nameBn: optText(160),
  slug: zSlug,
  stage: z.enum(PROJECT_STAGES),
  published: z.boolean(),
  featured: z.boolean(),
  sortOrder: z.number().int().min(-10_000).max(10_000),
  tagline: optText(200),
  taglineBn: optText(200),
  description: optText(10_000),
  descriptionBn: optText(10_000),
  highlights: z
    .array(z.object({ en: zText(200).optional(), bn: zText(200).optional() }).strict())
    .max(12),
  amenities: z
    .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
    .max(40)
    .refine((a) => new Set(a).size === a.length, 'Duplicate amenity'),
  location: zLocation,
  landArea: zLandAreaInput.nullable(),
  approval: z
    .object({ authority: z.enum(APPROVAL_AUTHORITIES).nullable().optional(), number: optText(80) })
    .strict()
    .nullable(),
  handoverAt: z.iso.date().nullable(), // YYYY-MM-DD
  coverMediaId: zid.nullable(),
  galleryMediaIds: z
    .array(zid)
    .max(40)
    .refine((a) => new Set(a).size === a.length, 'Duplicate image'),
  brochureMediaId: zid.nullable(),
  publicPricing: z.boolean(),
};

const optionalAll = (shape) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]));

export const zProjectCreate = z
  .object({ ...optionalAll(projectFields), name: projectFields.name, kind: z.enum(PROJECT_KINDS) })
  .strict();

export const zProjectPatch = z
  .object({ ...optionalAll(projectFields), version: zVersion })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

export const zProjectListQuery = {
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(PROJECT_KINDS).optional(),
  stage: z.enum(PROJECT_STAGES).optional(),
  published: z.enum(['true', 'false']).optional(),
};

const blockFields = {
  kind: z.enum(BLOCK_KINDS),
  code: zText(20).min(1),
  name: zText(120).min(1),
  nameBn: optText(120),
  lowestFloor: z.number().int().min(-5).max(200).nullable(),
  highestFloor: z.number().int().min(-5).max(200).nullable(),
  sortOrder: z.number().int().min(-10_000).max(10_000),
};

const floorsOrdered = (b) =>
  b.lowestFloor == null || b.highestFloor == null || b.lowestFloor <= b.highestFloor;

export const zBlockCreate = z
  .object({
    ...optionalAll(blockFields),
    kind: blockFields.kind,
    code: blockFields.code,
    name: blockFields.name,
  })
  .strict()
  .refine(floorsOrdered, 'lowestFloor must be ≤ highestFloor');

export const zBlockPatch = z
  .object({ ...optionalAll(blockFields), version: zVersion })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');
