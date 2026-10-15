import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { zText, zVersion } from '#modules/projects/project.validation.js';
import { META_EVENT_STATUSES } from '#modules/meta/metaLeadEvent.model.js';
import { SMS_PURPOSES, SMS_STATUSES } from '#modules/sms/smsMessage.model.js';

/** Integration settings (B3.2) — admin screens + SMS preview. Strict everywhere. */

const zMetaId = z
  .string()
  .trim()
  .regex(/^\d{1,30}$/, 'Numeric Meta id');

export const zMetaConnect = z
  .object({
    pageId: zMetaId,
    // Page token or a (system) user token with access to the Page. Never logged or returned.
    accessToken: z
      .string()
      .trim()
      .min(20)
      .max(1000)
      .regex(/^[A-Za-z0-9_\-|.]+$/, 'Invalid token'),
  })
  .strict();

export const zMetaForms = z
  .object({
    version: zVersion,
    mappings: z
      .array(
        z
          .object({
            formId: zMetaId,
            formName: zText(200).nullable().optional(),
            type: z.enum(['buyer', 'landowner']).default('buyer'),
            projectId: zid.nullable().optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const zMetaEvents = { status: z.enum(META_EVENT_STATUSES).optional(), ...cursorQuery };

export const zSmsList = {
  status: z.enum(SMS_STATUSES).optional(),
  purpose: z.enum(SMS_PURPOSES).optional(),
  leadId: zid.optional(),
  bookingId: zid.optional(), // B5: reminders / portal messages of one booking
  ...cursorQuery,
};

export const zSmsPreview = z
  .object({
    text: z.string().max(1600),
    // Fill {name}/{company} like the auto-reply would (sample name, company name in that language).
    locale: z.enum(['bn', 'en']).optional(),
  })
  .strict();

export const zSmsTest = z
  .object({
    to: z.string().trim().min(6).max(30),
    text: zText(480).min(1).optional(),
  })
  .strict();
