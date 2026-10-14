import { addDays, addMonths } from '#shared/utils/dhakaDate.js';
import { bpsOf, toBnDigits } from '#shared/utils/money.js';

/**
 * Payment schedule generator (B4) — pure, integer poisha.
 *
 * A plan template is:
 *   bookingMoney  { type: 'percent'|'fixed', value }                  due on the booking date
 *   downPayment   { type, value, dueAfterDays }                        optional
 *   installments  { count, everyMonths, firstDueAfterMonths }          optional, take the balance
 *   milestones    [{ key, label, labelBn, type, value }]               no due date until called
 *   handover      { type: 'percent'|'fixed'|'balance', value }         no due date until called
 *
 * percent = basis points of the contract price; fixed = poisha.
 * Exactly one part takes the BALANCE (contract − everything else): the installments when there
 * are any, otherwise a handover of type 'balance'. Percent parts are rounded DOWN to whole taka;
 * installments are equal whole-taka amounts and the last one absorbs the rounding remainder, so
 * the schedule always adds up to the contract exactly (ARCHITECTURE §5).
 */

export const ITEM_CODES = Object.freeze([
  'booking_money',
  'down_payment',
  'installment',
  'milestone',
  'handover',
  'charge', // B4.2: added later (transfer fee, bounce fee, delay charge…) — not part of the contract
]);

/** What a `charge` item is for (B4.2). Charges are outside the contract price. */
export const CHARGE_KINDS = Object.freeze([
  'delay',
  'utility',
  'registration',
  'transfer_fee',
  'cheque_bounce',
  'other',
]);

export class ScheduleError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const wholeTaka = (poisha) => Math.floor(poisha / 100) * 100;

function partAmount(contract, part) {
  if (part.type === 'fixed') return part.value;
  if (part.type === 'percent') return wholeTaka(bpsOf(contract, part.value));
  throw new ScheduleError('INVALID_PLAN', `Unknown amount type ${part.type}`);
}

const LABELS = {
  booking_money: ['Booking money', 'বুকিং মানি'],
  down_payment: ['Down payment', 'ডাউন পেমেন্ট'],
  handover: ['Payment at handover', 'হস্তান্তরের সময় পরিশোধ'],
};

function installmentLabels(i, n) {
  return [`Installment ${i} of ${n}`, `কিস্তি ${toBnDigits(i)}/${toBnDigits(n)}`];
}

/** Which part takes the balance; throws when the plan has none or two. */
export function balanceHolder(plan) {
  const inst = (plan.installments?.count ?? 0) > 0;
  const handoverBalance = plan.handover?.type === 'balance';
  if (inst && handoverBalance) {
    throw new ScheduleError(
      'INVALID_PLAN',
      'With installments, the handover payment must be a percent or a fixed amount',
    );
  }
  if (!inst && !handoverBalance) {
    throw new ScheduleError(
      'INVALID_PLAN',
      'The plan needs installments, or a handover payment that takes the balance',
    );
  }
  return inst ? 'installments' : 'handover';
}

/**
 * @param {object} a
 * @param {number} a.contract   poisha (> 0)
 * @param {object} a.plan       template (above)
 * @param {string} a.bookingDate 'YYYY-MM-DD'
 * @returns {Array<{seq, code, label, labelBn, dueDate: string|null, amount, milestoneKey?}>}
 */
export function generateSchedule({ contract, plan, bookingDate }) {
  if (!Number.isSafeInteger(contract) || contract <= 0) {
    throw new ScheduleError('INVALID_PRICE', 'Contract price must be positive');
  }
  const holder = balanceHolder(plan);
  const items = [];
  const push = (code, amount, dueDate, labels, extra = {}) =>
    items.push({ code, label: labels[0], labelBn: labels[1], dueDate, amount, ...extra });

  push('booking_money', partAmount(contract, plan.bookingMoney), bookingDate, LABELS.booking_money);
  if (plan.downPayment) {
    push(
      'down_payment',
      partAmount(contract, plan.downPayment),
      addDays(bookingDate, plan.downPayment.dueAfterDays ?? 0),
      LABELS.down_payment,
    );
  }
  const milestones = (plan.milestones ?? []).map((m) => ({
    code: 'milestone',
    label: m.label,
    labelBn: m.labelBn ?? m.label,
    dueDate: null,
    amount: partAmount(contract, m),
    milestoneKey: m.key,
  }));
  const handover =
    plan.handover && plan.handover.type !== 'balance'
      ? { code: 'handover', amount: partAmount(contract, plan.handover) }
      : null;

  const fixedSum =
    items.reduce((s, i) => s + i.amount, 0) +
    milestones.reduce((s, m) => s + m.amount, 0) +
    (handover?.amount ?? 0);
  const balance = contract - fixedSum;

  if (holder === 'installments') {
    const { count, everyMonths = 1, firstDueAfterMonths } = plan.installments;
    const first = firstDueAfterMonths ?? everyMonths;
    const each = wholeTaka(Math.floor(balance / count));
    if (balance <= 0 || each <= 0) {
      throw new ScheduleError(
        'PLAN_EXCEEDS_PRICE',
        'The fixed parts of this plan leave nothing for the installments',
        { contract, fixedSum },
      );
    }
    for (let i = 1; i <= count; i += 1) {
      const amount = i === count ? balance - each * (count - 1) : each;
      push(
        'installment',
        amount,
        addMonths(bookingDate, first + (i - 1) * everyMonths),
        installmentLabels(i, count),
      );
    }
    items.push(...milestones);
    if (handover) push('handover', handover.amount, null, LABELS.handover);
  } else {
    if (balance <= 0) {
      throw new ScheduleError('PLAN_EXCEEDS_PRICE', 'The plan adds up to more than the price', {
        contract,
        fixedSum,
      });
    }
    items.push(...milestones);
    push('handover', balance, null, LABELS.handover);
  }

  if (items.some((i) => i.amount <= 0)) {
    throw new ScheduleError('PLAN_EXCEEDS_PRICE', 'A schedule item came out as zero or less', {
      contract,
    });
  }
  return items.map((i, idx) => ({ seq: idx + 1, ...i }));
}

/**
 * A hand-made schedule (bookings:override): checks it adds up to the contract exactly and has
 * one booking-money item. Items keep the given order. `dueDate` null = called later.
 */
export function customSchedule({ contract, items, bookingDate }) {
  const sum = items.reduce((s, i) => s + i.amount, 0);
  if (sum !== contract) {
    throw new ScheduleError('SCHEDULE_TOTAL_MISMATCH', 'The schedule must add up to the price', {
      contract,
      scheduled: sum,
      difference: contract - sum,
    });
  }
  const bm = items.filter((i) => i.code === 'booking_money');
  if (bm.length !== 1) {
    throw new ScheduleError('INVALID_SCHEDULE', 'Add exactly one booking money item');
  }
  if (items.some((i) => i.dueDate && i.dueDate < bookingDate)) {
    throw new ScheduleError('INVALID_SCHEDULE', 'A due date is before the booking date');
  }
  return items.map((i, idx) => {
    const fallback = LABELS[i.code] ?? [i.code, i.code];
    return {
      seq: idx + 1,
      code: i.code,
      label: i.label ?? fallback[0],
      labelBn: i.labelBn ?? i.label ?? fallback[1],
      dueDate: i.code === 'booking_money' ? bookingDate : (i.dueDate ?? null),
      amount: i.amount,
    };
  });
}
