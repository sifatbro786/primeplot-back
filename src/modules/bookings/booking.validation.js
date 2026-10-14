import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { offsetQuery } from '#shared/utils/pagination.js';
import { zAmount, zChequePayment, zPayment } from '#modules/accounts/accounts.validation.js';
import { zNid } from '#modules/customers/customer.validation.js';

const text = (max) => z.string().trim().max(max);
const MAX_MONEY = 10_000_000_000_000;
const zMoney0 = z.number().int().min(0).max(MAX_MONEY);

// ── Plan templates ──────────────────────────────────────────────────────────────

const zPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ type: z.literal('fixed'), value: zAmount }).strict(),
]);

export const zPlanSpec = z
  .object({
    bookingMoney: zPart,
    downPayment: z
      .discriminatedUnion('type', [
        z
          .object({
            type: z.literal('percent'),
            value: z.number().int().min(1).max(10_000),
            dueAfterDays: z.number().int().min(0).max(365).default(0),
          })
          .strict(),
        z
          .object({
            type: z.literal('fixed'),
            value: zAmount,
            dueAfterDays: z.number().int().min(0).max(365).default(0),
          })
          .strict(),
      ])
      .nullable()
      .optional(),
    installments: z
      .object({
        count: z.number().int().min(1).max(240),
        everyMonths: z.literal([1, 2, 3, 4, 6, 12]),
        firstDueAfterMonths: z.number().int().min(0).max(36).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    milestones: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Use a-z, 0-9 and _'),
            label: text(120).min(2),
            labelBn: text(120).optional(),
            type: z.enum(['percent', 'fixed']),
            value: z.number().int().min(1).max(MAX_MONEY),
          })
          .strict()
          .refine((m) => m.type !== 'percent' || m.value <= 10_000, 'Percent is at most 100 %'),
      )
      .max(20)
      .refine((a) => new Set(a.map((m) => m.key)).size === a.length, 'Duplicate milestone key')
      .optional(),
    handover: z
      .discriminatedUnion('type', [
        z
          .object({ type: z.literal('percent'), value: z.number().int().min(1).max(10_000) })
          .strict(),
        z.object({ type: z.literal('fixed'), value: zAmount }).strict(),
        z.object({ type: z.literal('balance') }).strict(),
      ])
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const inst = Boolean(s.installments?.count);
    const bal = s.handover?.type === 'balance';
    if (inst === bal) {
      ctx.addIssue({
        code: 'custom',
        path: [inst ? 'handover' : 'installments'],
        message: inst
          ? 'With installments, the handover payment must be a percent or a fixed amount'
          : 'Add installments, or make the handover payment take the balance',
      });
    }
    // Percent parts alone must leave room for the balance.
    const pct =
      (s.bookingMoney.type === 'percent' ? s.bookingMoney.value : 0) +
      (s.downPayment?.type === 'percent' ? s.downPayment.value : 0) +
      (s.handover?.type === 'percent' ? s.handover.value : 0) +
      (s.milestones ?? []).reduce((t, m) => t + (m.type === 'percent' ? m.value : 0), 0);
    if (pct >= 10_000) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'Percent parts must add up to less than 100 %',
      });
    }
  });

const planFields = {
  projectId: zid.nullable(),
  name: text(120).min(2),
  nameBn: text(120).nullable(),
  description: text(500).nullable(),
  spec: zPlanSpec,
  active: z.boolean(),
  sortOrder: z.number().int().min(-1000).max(1000),
};
const optional = (shape) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]));

export const zPlanCreate = z
  .object({ ...optional(planFields), name: planFields.name, spec: planFields.spec })
  .strict();
export const zPlanPatch = z
  .object({ ...optional(planFields), version: z.number().int().min(0) })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');
export const zPlanList = {
  projectId: zid.optional(),
  active: z.enum(['true', 'false']).optional(),
};

// ── Bookings ────────────────────────────────────────────────────────────────────

const zCustomItem = z
  .object({
    code: z.enum(['booking_money', 'down_payment', 'installment', 'milestone', 'handover']),
    label: text(160).min(1).optional(),
    labelBn: text(160).optional(),
    dueDate: z.iso.date().nullable().optional(),
    amount: zAmount,
  })
  .strict();

const zNominee = z
  .object({
    name: text(160).min(2),
    relation: text(60).min(2),
    phone: text(30).nullable().optional(),
    nid: zNid.nullable().optional(),
    sharePct: z.number().int().min(1).max(100),
  })
  .strict();

export const zNominees = z
  .array(zNominee)
  .max(5)
  .refine(
    (a) => a.length === 0 || a.reduce((s, n) => s + n.sharePct, 0) === 100,
    'Nominee shares must add up to 100 %',
  );

const zDiscount = z
  .object({ amount: zMoney0, reason: text(300).optional() })
  .strict()
  .refine((d) => d.amount === 0 || (d.reason && d.reason.length >= 3), {
    message: 'Give a reason for the discount',
    path: ['reason'],
  });

/** Fields shared by preview and create. Either a template (planId) or a custom schedule. */
const sale = {
  unitId: zid,
  bookingDate: z.iso.date().optional(), // default today (Dhaka)
  discount: zDiscount.optional(),
  planId: zid.optional(),
  schedule: z.array(zCustomItem).min(1).max(300).optional(),
};
const onePlan = (b) => Boolean(b.planId) !== Boolean(b.schedule);
const onePlanIssue = { message: 'Give a payment plan or a custom schedule', path: ['planId'] };

export const zBookingPreview = z.object(sale).strict().refine(onePlan, onePlanIssue);

export const zBookingCreate = z
  .object({
    ...sale,
    customerId: zid,
    coApplicantIds: z
      .array(zid)
      .max(2)
      .refine((a) => new Set(a).size === a.length, 'Duplicate co-applicant')
      .optional(),
    nominees: zNominees.optional(),
    leadId: zid.optional(),
    // Guards against a rate change between the wizard's preview and the save.
    expectedTotal: zMoney0.optional(),
    payment: z.union([zPayment, zChequePayment]).optional(), // cheque: B4.2
    waiveReason: text(300).min(3).optional(), // bookings:override — no booking money now
    note: text(1000).optional(),
  })
  .strict()
  .refine(onePlan, onePlanIssue)
  .refine((b) => !(b.payment && b.waiveReason), {
    message: 'Either take the booking money or waive it, not both',
    path: ['waiveReason'],
  })
  .refine((b) => !b.coApplicantIds?.includes(b.customerId), {
    message: 'The applicant cannot also be a co-applicant',
    path: ['coApplicantIds'],
  });

export const zBookingPatch = z
  .object({
    version: z.number().int().min(0),
    nominees: zNominees.optional(),
    note: text(1000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'Nothing to update');

export const zBookingList = {
  ...offsetQuery,
  projectId: zid.optional(),
  status: z.enum(['active', 'cancelled']).optional(),
  soldBy: zid.optional(),
  customerId: zid.optional(),
  q: text(100).min(1).optional(), // booking no., unit code, customer name
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};
