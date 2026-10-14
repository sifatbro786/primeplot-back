import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { zT, zTObj } from '#modules/site/site.schema.js';
import { MILESTONES } from './constructionUpdate.model.js';

const DAY = 86_400_000;
/** Today's date in Dhaka (UTC+6), YYYY-MM-DD. */
export const dhakaToday = (now = Date.now()) =>
  new Date(now + 6 * 3_600_000).toISOString().slice(0, 10);
const tomorrow = () => dhakaToday(Date.now() + DAY);

const fields = {
  date: z.iso.date().refine((d) => d <= tomorrow(), 'The date cannot be in the future'),
  title: zTObj(160),
  body: zTObj(3000),
  percent: z.number().int().min(0).max(100).nullable(),
  milestone: z.enum(MILESTONES).nullable(),
  blockId: zid.nullable(),
  photos: z
    .array(z.object({ mediaId: zid, caption: zT(200) }).strict())
    .max(20, 'At most 20 photos')
    .refine((a) => new Set(a.map((p) => p.mediaId)).size === a.length, 'The same photo twice'),
  published: z.boolean(),
};

const optional = (shape) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]));

export const zUpdateCreate = z
  .object({ ...optional(fields), date: fields.date, title: fields.title })
  .strict()
  .refine((b) => b.title.en || b.title.bn, { message: 'Give a title', path: ['title'] });

export const zUpdatePatch = z
  .object({ ...optional(fields), version: z.number().int().min(0) })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

export const zUpdateList = {
  published: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
