import { z } from 'zod';
import { zemail, zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { zAmount } from '#modules/accounts/accounts.validation.js';
import { SLIP_CHANNELS, SLIP_STATUSES } from './paymentSlip.model.js';
import { PROFILE_REQUEST_STATUSES } from './profileRequest.model.js';

const text = (max) => z.string().trim().max(max);
const opt = (max) => text(max).nullable().optional();

export const zLocaleBody = z.object({ locale: z.enum(['bn', 'en']) }).strict();

export const zDuesQuery = { days: z.coerce.number().int().min(0).max(365).default(60) };

export const zDocQuery = {
  locale: z.enum(['bn', 'en']).optional(),
  download: z.enum(['1', '0']).optional(),
};

/** A slip as the client fills it in (after uploading the file as `payment_slip`). */
export const zSlipCreate = z
  .object({
    amount: zAmount,
    paidOn: z.iso.date(),
    channel: z.enum(SLIP_CHANNELS),
    bankAccountId: zid.nullable().optional(), // which company account (from GET /portal/me)
    reference: text(80).min(2).nullable().optional(),
    payerBank: opt(120),
    mediaId: zid,
    note: opt(500),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.channel !== 'pay_order' && !s.bankAccountId) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankAccountId'],
        message: 'Which account did you pay into?',
      });
    }
    if (s.channel === 'bank_transfer' && !s.reference) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference'],
        message: 'Transaction / reference number',
      });
    }
  });

export const zSlipList = { status: z.enum(SLIP_STATUSES).optional(), ...cursorQuery };
export const zStaffSlipList = { ...zSlipList, bookingId: zid.optional() };

export const zSlipApprove = z
  .object({
    // Correct to what the bank statement shows (default: what the client entered).
    amount: zAmount.optional(),
    date: z.iso.date().optional(),
    bankAccountId: zid.nullable().optional(),
    reference: text(80).min(1).nullable().optional(),
    note: opt(500),
  })
  .strict();

export const zReason = z.object({ reason: text(500).min(3) }).strict();

export const zProfileRequest = z
  .object({
    phone: text(20).min(6).optional(),
    altPhone: text(20).nullable().optional(),
    email: z
      .union([zemail, z.literal('')])
      .nullable()
      .optional(),
    presentAddress: opt(500),
    permanentAddress: opt(500),
    foreignAddress: opt(500),
    occupation: opt(120),
    organization: opt(160),
    note: opt(500),
  })
  .strict();

export const zProfileRequestList = {
  status: z.enum(PROFILE_REQUEST_STATUSES).optional(),
  customerId: zid.optional(),
  ...cursorQuery,
};

export const zPortalAccess = z.object({ enabled: z.boolean() }).strict();
export const zInvite = z.object({ force: z.boolean().default(false) }).strict();
