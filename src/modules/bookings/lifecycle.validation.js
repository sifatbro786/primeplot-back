import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { cursorQuery, offsetQuery } from '#shared/utils/pagination.js';
import { zAmount, zChequeFields } from '#modules/accounts/accounts.validation.js';
import { CHEQUE_STATUSES } from '#modules/accounts/cheque.model.js';
import { zNominees } from './booking.validation.js';
import { CHARGE_KINDS } from './schedule.js';

/** B4.2 request schemas: cheques, schedule changes, sale stages, transfer, cancel, refund. */
const text = (max) => z.string().trim().max(max);
const zDate = z.iso.date();

// ── Cheques ─────────────────────────────────────────────────────────────────────

export const zChequeCreate = z
  .object({ ...zChequeFields, receivedDate: zDate.optional() })
  .strict();

export const zChequeDeposit = z
  .object({ date: zDate.optional(), bankAccountId: zid, note: text(500).optional() })
  .strict();
export const zChequeClear = z
  .object({ date: zDate.optional(), bankAccountId: zid.optional(), note: text(500).optional() })
  .strict();
export const zChequeBounce = z
  .object({
    date: zDate.optional(),
    reason: text(300).min(3),
    fee: z.number().int().min(0).max(10_000_000).optional(), // default: accounts setting
  })
  .strict();
export const zChequeReturn = z.object({ reason: text(300).min(3) }).strict();

export const zChequeList = {
  ...cursorQuery,
  status: z.enum(CHEQUE_STATUSES).optional(),
  open: z.enum(['true', 'false']).optional(), // received + deposited
  projectId: zid.optional(),
  bookingId: zid.optional(),
  dueFrom: zDate.optional(), // cheque date range
  dueTo: zDate.optional(),
  q: text(40).min(2).optional(), // cheque no.
};

// ── Schedule ────────────────────────────────────────────────────────────────────

export const zChargeCreate = z
  .object({
    kind: z.enum(CHARGE_KINDS.filter((k) => k !== 'cheque_bounce' && k !== 'transfer_fee')),
    label: text(160).min(2),
    labelBn: text(160).optional(),
    amount: zAmount,
    dueDate: zDate,
    note: text(300).optional(),
  })
  .strict();

export const zReasonBody = z.object({ reason: text(500).min(3) }).strict();

export const zCallItem = z.object({ dueDate: zDate, note: text(300).optional() }).strict();

export const zReschedule = z
  .object({
    version: z.number().int().min(0),
    reason: text(500).min(3),
    items: z
      .array(
        z
          .object({
            id: zid.optional(), // existing item (keeps its payments); omit for a new one
            code: z.enum(['booking_money', 'down_payment', 'installment', 'milestone', 'handover']),
            label: text(160).min(1).optional(),
            labelBn: text(160).optional(),
            dueDate: zDate.nullable().optional(),
            amount: zAmount,
          })
          .strict(),
      )
      .min(1)
      .max(300)
      .refine((a) => {
        const ids = a.map((i) => i.id).filter(Boolean);
        return new Set(ids).size === ids.length;
      }, 'Duplicate item id'),
  })
  .strict();

// ── Stages ──────────────────────────────────────────────────────────────────────

export const zAllot = z.object({ date: zDate.optional(), note: text(500).optional() }).strict();
export const zRegister = z
  .object({
    date: zDate.optional(),
    deedNo: text(60).min(1),
    subRegistryOffice: text(120).optional(),
    note: text(500).optional(),
  })
  .strict();
export const zHandover = zAllot;

// ── Transfer / cancel / refund ──────────────────────────────────────────────────

export const zTransfer = z
  .object({
    toCustomerId: zid,
    coApplicantIds: z
      .array(zid)
      .max(2)
      .refine((a) => new Set(a).size === a.length, 'Duplicate co-applicant')
      .optional(),
    nominees: zNominees.optional(),
    date: zDate.optional(),
    note: text(500).optional(),
    waiveFeeReason: text(300).min(3).optional(),
  })
  .strict()
  .refine((b) => !b.coApplicantIds?.includes(b.toCustomerId), {
    message: 'The new holder cannot also be a co-applicant',
    path: ['coApplicantIds'],
  });

export const zCancelPreview = z
  .object({ deductionAmount: z.number().int().min(0).optional() })
  .strict();

export const zCancel = z
  .object({
    reason: text(500).min(3),
    date: zDate.optional(),
    deductionAmount: z.number().int().min(0).optional(), // default: project policy
    overrideReason: text(300).min(3).optional(),
  })
  .strict();

export const zRefund = z
  .object({
    amount: zAmount,
    mode: z.enum(['cash', 'bank_transfer', 'pay_order', 'cheque']),
    date: zDate.optional(),
    bankAccountId: zid.nullable().optional(), // company account the money left from
    reference: text(80).nullable().optional(),
    instrumentNo: text(40).nullable().optional(), // our cheque / pay order no.
    note: text(500).nullable().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.mode === 'cheque' || r.mode === 'pay_order') && !r.instrumentNo) {
      ctx.addIssue({
        code: 'custom',
        path: ['instrumentNo'],
        message: 'Cheque / pay order number',
      });
    }
    if (r.mode === 'bank_transfer' && (!r.bankAccountId || !r.reference)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference'],
        message: 'Company account and transfer reference are required',
      });
    }
  });

// ── Reports ─────────────────────────────────────────────────────────────────────

export const zDuesReport = {
  ...offsetQuery,
  projectId: zid.optional(),
  soldBy: zid.optional(),
  asOf: zDate.optional(),
  overdueOnly: z.enum(['true', 'false']).default('true'),
};
export const zCollectionsReport = {
  projectId: zid.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  interval: z.enum(['day', 'month']).default('day'),
};
export const zPdcReport = {
  projectId: zid.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
};
