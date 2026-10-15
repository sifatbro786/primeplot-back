import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { RECEIPT_MODES } from './receipt.model.js';
import { REMINDER_KINDS, REMINDER_TEXT_MAX } from '#modules/reminders/reminderText.js';

const MAX_MONEY = 10_000_000_000_000; // ৳1,000 crore in poisha
export const zAmount = z.number().int().min(1).max(MAX_MONEY);
const zBps = z.number().int().min(0).max(10_000);
const text = (max) => z.string().trim().max(max);
const zReminderText = z
  .string()
  .trim()
  .max(REMINDER_TEXT_MAX)
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || v.length >= 10, 'At least 10 characters (or leave empty)');

/** Modes accepted from staff now; cheque arrives with the register (B4.2), online/slip in B5. */
export const STAFF_MODES = Object.freeze(['cash', 'bank_transfer', 'pay_order']);

/**
 * A payment as entered by staff. Mode-specific requirements:
 *   bank_transfer → bankAccountId + reference;  pay_order → instrumentNo + instrumentBank.
 */
export const zPayment = z
  .object({
    amount: zAmount,
    mode: z.enum(STAFF_MODES),
    date: z.iso.date().optional(), // default today (Dhaka); booking step: the booking date
    bankAccountId: zid.nullable().optional(),
    reference: text(80).min(1).nullable().optional(),
    instrumentNo: text(40).min(1).nullable().optional(),
    instrumentBank: text(120).min(1).nullable().optional(),
    instrumentDate: z.iso.date().nullable().optional(),
    note: text(500).nullable().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const need = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (p.mode === 'bank_transfer') {
      if (!p.bankAccountId) need('bankAccountId', 'Which company account received it?');
      if (!p.reference) need('reference', 'Transfer reference is required');
    }
    if (p.mode === 'pay_order') {
      if (!p.instrumentNo) need('instrumentNo', 'Pay order number is required');
      if (!p.instrumentBank) need('instrumentBank', 'Issuing bank is required');
    }
  });

/** A customer cheque as entered (B4.2). */
export const zChequeFields = {
  chequeNo: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,20}$/, '4–20 digits/letters'),
  bank: text(120).min(2),
  branch: text(120).nullable().optional(),
  chequeDate: z.iso.date(), // a later date = post-dated (PDC)
  amount: zAmount,
  note: text(500).nullable().optional(),
};

/** Booking money paid by cheque (POST /bookings `payment`) — receipt when it clears. */
export const zChequePayment = z.object({ mode: z.literal('cheque'), ...zChequeFields }).strict();

export const zReverse = z.object({ reason: text(500).min(3) }).strict();

export const zReceiptList = {
  ...cursorQuery,
  projectId: zid.optional(),
  bookingId: zid.optional(),
  mode: z.enum(RECEIPT_MODES).optional(),
  status: z.enum(['valid', 'reversed']).optional(),
  receiptNo: text(40).min(3).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};

export const zSettingsPatch = z
  .object({
    version: z.number().int().min(0),
    discountLimitBps: z
      .object({ sales_executive: zBps.optional(), sales_manager: zBps.optional() })
      .strict()
      .optional(),
    bookingMoneyRequired: z.boolean().optional(),
    receiptBackdateDays: z.number().int().min(0).max(366).optional(),
    chequeBounceFee: z.number().int().min(0).max(10_000_000).optional(), // ≤ ৳1,00,000
    notify: z
      .object({ receiptEmail: z.boolean().optional(), receiptSms: z.boolean().optional() })
      .strict()
      .optional(),
    // B5.1
    portal: z
      .object({
        autoInvite: z.boolean().optional(),
        autoInviteCoApplicants: z.boolean().optional(),
        inviteSms: z.boolean().optional(),
        inviteEmail: z.boolean().optional(),
        slipUpload: z.boolean().optional(),
        onlinePayment: z.boolean().optional(),
        onlineMinAmount: z.number().int().min(100).max(100_000_000).optional(), // ৳1 … ৳10 lakh
        resultSms: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // B5.3 — `rules` replaces the whole list
    reminders: z
      .object({
        enabled: z.boolean().optional(),
        sendHour: z.number().int().min(7).max(21).optional(),
        coApplicants: z.boolean().optional(),
        // Replaces all six texts; null / '' = the built-in text. Length + placeholders are
        // checked in the service (they need the company name).
        texts: z
          .object(
            Object.fromEntries(
              REMINDER_KINDS.map((k) => [
                k,
                z
                  .object({ bn: zReminderText, en: zReminderText })
                  .strict()
                  .default({ bn: null, en: null }),
              ]),
            ),
          )
          .strict()
          .optional(),
        rules: z
          .array(
            z
              .object({
                key: z.string().regex(/^[a-z0-9_]{1,30}$/),
                offsetDays: z.number().int().min(-60).max(120),
                enabled: z.boolean().default(true),
                sms: z.boolean().default(true),
                email: z.boolean().default(true),
              })
              .strict(),
          )
          .max(8)
          .refine((r) => new Set(r.map((x) => x.key)).size === r.length, 'Rule keys repeat')
          .refine(
            (r) => new Set(r.map((x) => x.offsetDays)).size === r.length,
            'Two rules on the same day',
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

const bankFields = {
  name: text(120).min(2),
  bankName: text(120).min(2),
  branch: text(120).nullable().optional(),
  accountName: text(160).nullable().optional(),
  accountNo: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,40}$/, 'Digits, letters and dashes only'),
  routingNo: z
    .string()
    .trim()
    .regex(/^\d{9}$/, 'Routing number is 9 digits')
    .nullable()
    .optional(),
  active: z.boolean().optional(),
};

export const zBankCreate = z.object(bankFields).strict();
export const zBankPatch = z
  .object({
    ...Object.fromEntries(Object.entries(bankFields).map(([k, v]) => [k, v.optional()])),
    version: z.number().int().min(0),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');
