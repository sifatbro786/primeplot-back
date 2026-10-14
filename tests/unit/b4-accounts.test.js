import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { amountInWords, bpsOf, formatTaka, toBnDigits } from '#shared/utils/money.js';
import {
  addDays,
  addMonths,
  daysBetween,
  fiscalYear,
  parseDhakaDate,
  toDhakaDate,
} from '#shared/utils/dhakaDate.js';
import { P, hasPermission } from '#shared/auth/permissions.js';
import { idempotencyKey } from '#shared/middleware/idempotency.js';
import {
  allocate,
  allocationOrder,
  itemStatus,
  outstandingOf,
  scheduleTotals,
} from '#modules/accounts/allocation.js';
import { receiptNumber, discountCapBps } from '#modules/accounts/accounts.service.js';
import { zPayment, zSettingsPatch } from '#modules/accounts/accounts.validation.js';
import { Receipt } from '#modules/accounts/receipt.model.js';
import { LedgerEntry } from '#modules/accounts/ledgerEntry.model.js';
import { customSchedule, generateSchedule, ScheduleError } from '#modules/bookings/schedule.js';
import { zBookingCreate, zNominees, zPlanSpec } from '#modules/bookings/booking.validation.js';
import { zCustomerCreate } from '#modules/customers/customer.validation.js';
import { Booking } from '#modules/bookings/booking.model.js';

const TK = 100;
const LAKH = 100_000 * TK;
const CRORE = 100 * LAKH;
const id = () => new mongoose.Types.ObjectId();
const sum = (items) => items.reduce((s, i) => s + i.amount, 0);

// ── Money ──────────────────────────────────────────────────────────────────────

describe('money formatting and words', () => {
  it('lakh/crore grouping, poisha, Bangla digits', () => {
    expect(formatTaka(12550000000)).toBe('12,55,00,000.00');
    expect(formatTaka(125_50_000 * TK + 5)).toBe('1,25,50,000.05');
    expect(formatTaka(99_999)).toBe('999.99');
    expect(formatTaka(100_000 * TK, { decimals: false })).toBe('1,00,000');
    expect(formatTaka(-1_500 * TK)).toBe('-1,500.00');
    expect(formatTaka(1_25_000 * TK, { bn: true, decimals: false })).toBe('১,২৫,০০০');
    expect(toBnDigits('2026-27')).toBe('২০২৬-২৭');
    expect(() => formatTaka(1.5)).toThrow();
  });

  it('English words in the Indian system', () => {
    expect(amountInWords(0)).toBe('Zero Taka Only');
    expect(amountInWords(1 * TK)).toBe('One Taka Only');
    expect(amountInWords(1_25_50_000 * TK)).toBe(
      'One Crore Twenty-Five Lakh Fifty Thousand Taka Only',
    );
    expect(amountInWords(1_25_50_000 * TK + 50)).toBe(
      'One Crore Twenty-Five Lakh Fifty Thousand Taka and Fifty Poisha Only',
    );
    expect(amountInWords(150 * CRORE + 999 * TK)).toBe(
      'One Hundred Fifty Crore Nine Hundred Ninety-Nine Taka Only',
    );
    expect(amountInWords(10_011 * TK)).toBe('Ten Thousand Eleven Taka Only');
  });

  it('Bangla words', () => {
    expect(amountInWords(1_25_50_000 * TK, 'bn')).toBe(
      'এক কোটি পঁচিশ লক্ষ পঞ্চাশ হাজার টাকা মাত্র',
    );
    expect(amountInWords(5_00_000 * TK + 25, 'bn')).toBe('পাঁচ লক্ষ টাকা পঁচিশ পয়সা মাত্র');
    expect(amountInWords(99_999 * TK, 'bn')).toBe('নিরানব্বই হাজার নয় শত নিরানব্বই টাকা মাত্র');
    expect(amountInWords(150 * CRORE, 'bn')).toBe('এক শত পঞ্চাশ কোটি টাকা মাত্র');
    expect(amountInWords(0, 'bn')).toBe('শূন্য টাকা মাত্র');
  });

  it('refuses negatives and fractions', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(0.5)).toThrow(TypeError);
  });

  it('bpsOf rounds half away from zero and stays exact above 2^53', () => {
    expect(bpsOf(10_000, 100)).toBe(100);
    expect(bpsOf(150, 3333)).toBe(50); // 49.995 → 50
    expect(bpsOf(-150, 3333)).toBe(-50);
    expect(bpsOf(1000 * CRORE, 9999)).toBe(999_900_000_000); // 1e12 × 9999 > 2^53
  });
});

// ── Dates ──────────────────────────────────────────────────────────────────────

describe('Dhaka calendar dates', () => {
  it('round-trips through 00:00 Dhaka', () => {
    const d = parseDhakaDate('2026-10-14');
    expect(d.toISOString()).toBe('2026-10-13T18:00:00.000Z');
    expect(toDhakaDate(d)).toBe('2026-10-14');
    // 23:30 UTC on the 13th is already the 14th in Dhaka.
    expect(toDhakaDate(new Date('2026-10-13T23:30:00Z'))).toBe('2026-10-14');
  });

  it('adds months with month-end clamping and days across years', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-10-14', 3)).toBe('2027-01-14');
    expect(addMonths('2026-12-15', 12)).toBe('2027-12-15');
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
    expect(daysBetween('2026-10-01', '2026-10-14')).toBe(13);
    expect(daysBetween('2026-10-14', '2026-10-01')).toBe(-13);
  });

  it('fiscal year (July–June) and calendar years', () => {
    expect(fiscalYear('2026-10-14', 7)).toEqual({
      startYear: 2026,
      label: '2026-27',
      short: '2627',
    });
    expect(fiscalYear('2027-06-30', 7).label).toBe('2026-27');
    expect(fiscalYear('2027-07-01', 7).label).toBe('2027-28');
    expect(fiscalYear('2099-08-01', 7).short).toBe('9900');
    expect(fiscalYear('2026-03-01', 1)).toEqual({ startYear: 2026, label: '2026', short: '2026' });
    expect(receiptNumber('LVR', fiscalYear('2026-10-14'), 123)).toBe('LVR-2627-000123');
  });
});

// ── Schedule generator ─────────────────────────────────────────────────────────

const PLAN = {
  bookingMoney: { type: 'fixed', value: 5 * LAKH },
  downPayment: { type: 'percent', value: 2000, dueAfterDays: 15 },
  installments: { count: 36, everyMonths: 1 },
  milestones: [
    { key: 'roof', label: 'Roof casting', labelBn: 'ছাদ ঢালাই', type: 'percent', value: 500 },
  ],
  handover: { type: 'percent', value: 1000 },
};

describe('generateSchedule', () => {
  it('adds up to the contract exactly; last installment takes the rounding', () => {
    const contract = 1_23_45_678 * TK + 99;
    const items = generateSchedule({ contract, plan: PLAN, bookingDate: '2026-10-14' });
    expect(sum(items)).toBe(contract);
    expect(items[0]).toMatchObject({
      seq: 1,
      code: 'booking_money',
      dueDate: '2026-10-14',
      amount: 5 * LAKH,
    });
    expect(items[1]).toMatchObject({ code: 'down_payment', dueDate: '2026-10-29' });
    expect(items[1].amount % TK).toBe(0); // percent parts are whole taka
    const inst = items.filter((i) => i.code === 'installment');
    expect(inst).toHaveLength(36);
    expect(inst[0].dueDate).toBe('2026-11-14');
    expect(inst[35].dueDate).toBe('2029-10-14');
    expect(inst[0].label).toBe('Installment 1 of 36');
    expect(inst[0].labelBn).toBe('কিস্তি ১/৩৬');
    expect(new Set(inst.slice(0, 35).map((i) => i.amount)).size).toBe(1);
    expect(inst[35].amount).toBeGreaterThanOrEqual(inst[0].amount);
    expect(items.find((i) => i.code === 'milestone')).toMatchObject({
      dueDate: null,
      milestoneKey: 'roof',
    });
    expect(items.at(-1)).toMatchObject({ code: 'handover', dueDate: null });
    expect(items.map((i) => i.seq)).toEqual(items.map((_, k) => k + 1));
  });

  it('handover can take the balance when there are no installments', () => {
    const items = generateSchedule({
      contract: 50 * LAKH,
      plan: { bookingMoney: { type: 'percent', value: 1000 }, handover: { type: 'balance' } },
      bookingDate: '2026-10-14',
    });
    expect(items.map((i) => [i.code, i.amount])).toEqual([
      ['booking_money', 5 * LAKH],
      ['handover', 45 * LAKH],
    ]);
  });

  it('quarterly installments with a first-due offset', () => {
    const items = generateSchedule({
      contract: 1 * CRORE,
      plan: {
        bookingMoney: { type: 'fixed', value: 2 * LAKH },
        installments: { count: 4, everyMonths: 3, firstDueAfterMonths: 1 },
      },
      bookingDate: '2026-01-31',
    });
    expect(items.filter((i) => i.code === 'installment').map((i) => i.dueDate)).toEqual([
      '2026-02-28',
      '2026-05-31',
      '2026-08-31',
      '2026-11-30',
    ]);
  });

  it('fuzz: 2,000 random plans always sum to the contract and never produce ≤ 0 items', () => {
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let k = 0; k < 2000; k += 1) {
      const contract = (20 * LAKH + rnd(30 * CRORE)) * 1 + rnd(100);
      const plan = {
        bookingMoney: rnd(2)
          ? { type: 'fixed', value: (1 + rnd(5)) * LAKH }
          : { type: 'percent', value: 100 + rnd(1000) },
        downPayment: rnd(2)
          ? { type: 'percent', value: 500 + rnd(2000), dueAfterDays: rnd(60) }
          : null,
        installments: { count: 1 + rnd(120), everyMonths: [1, 3, 6][rnd(3)] },
        handover: rnd(2) ? { type: 'percent', value: 100 + rnd(1500) } : null,
      };
      try {
        const items = generateSchedule({ contract, plan, bookingDate: '2026-10-14' });
        expect(sum(items)).toBe(contract);
        expect(items.every((i) => Number.isSafeInteger(i.amount) && i.amount > 0)).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(ScheduleError);
        expect(err.code).toBe('PLAN_EXCEEDS_PRICE');
      }
    }
  });

  it('refuses plans that exceed the price or have no/two balance holders', () => {
    expect(() =>
      generateSchedule({
        contract: 10 * LAKH,
        plan: {
          bookingMoney: { type: 'fixed', value: 11 * LAKH },
          installments: { count: 3, everyMonths: 1 },
        },
        bookingDate: '2026-10-14',
      }),
    ).toThrow(expect.objectContaining({ code: 'PLAN_EXCEEDS_PRICE' }));
    expect(() =>
      generateSchedule({
        contract: 10 * LAKH,
        plan: { bookingMoney: { type: 'fixed', value: LAKH } },
        bookingDate: '2026-10-14',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PLAN' }));
    expect(() =>
      generateSchedule({
        contract: 10 * LAKH,
        plan: {
          bookingMoney: { type: 'fixed', value: LAKH },
          installments: { count: 2, everyMonths: 1 },
          handover: { type: 'balance' },
        },
        bookingDate: '2026-10-14',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PLAN' }));
  });

  it('custom schedule must match the contract and have one booking-money item', () => {
    const items = [
      { code: 'booking_money', amount: 2 * LAKH },
      { code: 'installment', amount: 8 * LAKH, dueDate: '2026-12-01', label: 'Bullet' },
    ];
    const out = customSchedule({ contract: 10 * LAKH, items, bookingDate: '2026-10-14' });
    expect(out[0]).toMatchObject({ seq: 1, dueDate: '2026-10-14', label: 'Booking money' });
    expect(out[1]).toMatchObject({ seq: 2, label: 'Bullet', labelBn: 'Bullet' });
    expect(() =>
      customSchedule({ contract: 10 * LAKH + 1, items, bookingDate: '2026-10-14' }),
    ).toThrow(
      expect.objectContaining({
        code: 'SCHEDULE_TOTAL_MISMATCH',
        details: expect.objectContaining({ difference: 1 }),
      }),
    );
    expect(() =>
      customSchedule({
        contract: 10 * LAKH,
        items: [{ code: 'installment', amount: 10 * LAKH }],
        bookingDate: '2026-10-14',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCHEDULE' }));
    expect(() =>
      customSchedule({
        contract: 10 * LAKH,
        items: [items[0], { ...items[1], dueDate: '2026-01-01' }],
        bookingDate: '2026-10-14',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCHEDULE' }));
  });
});

// ── Allocation ─────────────────────────────────────────────────────────────────

const item = (seq, amount, dueDate, paid = 0, code = 'installment') => ({
  _id: id(),
  seq,
  code,
  label: `#${seq}`,
  amount,
  paid,
  dueDate: dueDate ? parseDhakaDate(dueDate) : null,
});

describe('allocation (oldest first)', () => {
  const schedule = () => [
    item(1, 5 * LAKH, '2026-10-14', 0, 'booking_money'),
    item(2, 2 * LAKH, '2026-11-14'),
    item(3, 2 * LAKH, '2026-12-14'),
    item(4, 3 * LAKH, null, 0, 'milestone'),
    item(5, 1 * LAKH, '2027-01-14'),
  ];

  it('orders dated items by date, undated last', () => {
    expect(allocationOrder(schedule()).map((i) => i.seq)).toEqual([1, 2, 3, 5, 4]);
  });

  it('partial, exact and advance payments', () => {
    const s = schedule();
    expect(allocate(s, 3 * LAKH).map((a) => [a.seq, a.amount])).toEqual([[1, 3 * LAKH]]);
    expect(allocate(s, 8 * LAKH).map((a) => [a.seq, a.amount])).toEqual([
      [1, 5 * LAKH],
      [2, 2 * LAKH],
      [3, 1 * LAKH],
    ]);
    s[0].paid = 5 * LAKH;
    s[1].paid = 50_000 * TK;
    expect(allocate(s, 2 * LAKH).map((a) => [a.seq, a.amount])).toEqual([
      [2, 1_50_000 * TK],
      [3, 50_000 * TK],
    ]);
    // Everything left: milestone (undated) comes last.
    const all = allocate(s, outstandingOf(s));
    expect(all.at(-1).seq).toBe(4);
    expect(sum(all)).toBe(outstandingOf(s));
  });

  it('refuses overpayment, zero and fractions', () => {
    const s = schedule();
    expect(() => allocate(s, outstandingOf(s) + 1)).toThrow(
      expect.objectContaining({ message: 'OVERPAYMENT', outstanding: 13 * LAKH }),
    );
    expect(() => allocate(s, 0)).toThrow('INVALID_AMOUNT');
    expect(() => allocate(s, 10.5)).toThrow('INVALID_AMOUNT');
  });

  it('totals and item status as of a date', () => {
    const s = schedule();
    s[0].paid = 5 * LAKH;
    s[1].paid = 1 * LAKH;
    const t = scheduleTotals(s, '2026-11-20');
    expect(t).toMatchObject({
      total: 13 * LAKH,
      paid: 6 * LAKH,
      outstanding: 7 * LAKH,
      dueNow: 1 * LAKH,
      overdue: 1 * LAKH,
    });
    expect(t.nextDue).toMatchObject({ itemId: String(s[2]._id), amount: 2 * LAKH });
    expect(itemStatus(s[0], '2026-11-20')).toBe('paid');
    expect(itemStatus(s[1], '2026-11-20')).toBe('overdue');
    expect(itemStatus(s[2], '2026-12-14')).toBe('due');
    expect(itemStatus(s[4], '2026-11-20')).toBe('upcoming');
    expect(itemStatus(s[3], '2026-11-20')).toBe('not_called');
  });
});

// ── Request schemas ────────────────────────────────────────────────────────────

describe('B4 request schemas', () => {
  it('plan spec: exactly one balance holder, percent parts < 100 %', () => {
    expect(zPlanSpec.safeParse(PLAN).success).toBe(true);
    expect(
      zPlanSpec.safeParse({
        bookingMoney: { type: 'fixed', value: LAKH },
        handover: { type: 'balance' },
      }).success,
    ).toBe(true);
    expect(zPlanSpec.safeParse({ bookingMoney: { type: 'fixed', value: LAKH } }).success).toBe(
      false,
    );
    expect(zPlanSpec.safeParse({ ...PLAN, handover: { type: 'balance' } }).success).toBe(false);
    expect(
      zPlanSpec.safeParse({
        bookingMoney: { type: 'percent', value: 6000 },
        downPayment: { type: 'percent', value: 4000 },
        installments: { count: 2, everyMonths: 1 },
      }).success,
    ).toBe(false);
    expect(
      zPlanSpec.safeParse({ ...PLAN, installments: { count: 12, everyMonths: 5 } }).success,
    ).toBe(false);
    expect(zPlanSpec.safeParse({ ...PLAN, extra: 1 }).success).toBe(false);
    const parsed = zPlanSpec.parse({ ...PLAN, downPayment: { type: 'fixed', value: LAKH } });
    expect(parsed.downPayment.dueAfterDays).toBe(0);
  });

  it('payment: mode-specific fields', () => {
    expect(zPayment.safeParse({ amount: LAKH, mode: 'cash' }).success).toBe(true);
    expect(zPayment.safeParse({ amount: LAKH, mode: 'bank_transfer' }).success).toBe(false);
    expect(
      zPayment.safeParse({
        amount: LAKH,
        mode: 'bank_transfer',
        bankAccountId: String(id()),
        reference: 'TRX1',
      }).success,
    ).toBe(true);
    expect(
      zPayment.safeParse({ amount: LAKH, mode: 'pay_order', instrumentNo: '123' }).success,
    ).toBe(false);
    expect(zPayment.safeParse({ amount: LAKH, mode: 'cheque' }).success).toBe(false); // B4.2
    expect(zPayment.safeParse({ amount: 0, mode: 'cash' }).success).toBe(false);
    expect(zPayment.safeParse({ amount: 10.5, mode: 'cash' }).success).toBe(false);
    expect(zPayment.safeParse({ amount: LAKH, mode: 'cash', $where: '1' }).success).toBe(false);
  });

  it('booking: plan xor schedule, payment xor waiver, applicant not co-applicant, nominee shares', () => {
    const base = { unitId: String(id()), customerId: String(id()), planId: String(id()) };
    expect(zBookingCreate.safeParse(base).success).toBe(true);
    expect(
      zBookingCreate.safeParse({ ...base, schedule: [{ code: 'booking_money', amount: 1 }] })
        .success,
    ).toBe(false);
    const { planId: _p, ...noPlan } = base;
    expect(zBookingCreate.safeParse(noPlan).success).toBe(false);
    expect(
      zBookingCreate.safeParse({
        ...base,
        payment: { amount: LAKH, mode: 'cash' },
        waiveReason: 'later',
      }).success,
    ).toBe(false);
    expect(zBookingCreate.safeParse({ ...base, coApplicantIds: [base.customerId] }).success).toBe(
      false,
    );
    expect(zBookingCreate.safeParse({ ...base, discount: { amount: 5 * LAKH } }).success).toBe(
      false,
    );
    expect(
      zBookingCreate.safeParse({
        ...base,
        discount: { amount: 5 * LAKH, reason: 'Festival offer' },
      }).success,
    ).toBe(true);
    expect(zNominees.safeParse([{ name: 'Karim', relation: 'Son', sharePct: 60 }]).success).toBe(
      false,
    );
    expect(
      zNominees.safeParse([
        { name: 'Karim', relation: 'Son', sharePct: 60 },
        { name: 'Rina', relation: 'Daughter', sharePct: 40 },
      ]).success,
    ).toBe(true);
  });

  it('customer: NID length, TIN, unknown keys', () => {
    const c = { name: 'Abdur Rahim', phone: '01712345678' };
    expect(zCustomerCreate.safeParse(c).success).toBe(true);
    expect(zCustomerCreate.safeParse({ ...c, nid: '1234567890' }).success).toBe(true);
    expect(zCustomerCreate.safeParse({ ...c, nid: '12345678901' }).success).toBe(false);
    expect(zCustomerCreate.safeParse({ ...c, tin: '123' }).success).toBe(false);
    expect(zCustomerCreate.safeParse({ ...c, accessUserIds: [] }).success).toBe(false);
  });

  it('settings patch needs a version and something to change', () => {
    expect(zSettingsPatch.safeParse({ version: 0 }).success).toBe(false);
    expect(
      zSettingsPatch.safeParse({ version: 0, discountLimitBps: { sales_executive: 200 } }).success,
    ).toBe(true);
    expect(zSettingsPatch.safeParse({ version: 0, discountLimitBps: { admin: 1 } }).success).toBe(
      false,
    );
  });
});

// ── Permissions, discount cap, idempotency, immutability ───────────────────────

describe('B4 permissions and guards', () => {
  it('bundles: executive books; manager reads all, overrides, takes receipts; only admin reverses', () => {
    expect(hasPermission('sales_executive', P.BOOKINGS_CREATE)).toBe(true);
    expect(hasPermission('sales_executive', P.BOOKINGS_READ_ALL)).toBe(false);
    expect(hasPermission('sales_executive', P.RECEIPTS_CREATE)).toBe(false);
    expect(hasPermission('sales_executive', P.BOOKINGS_OVERRIDE)).toBe(false);
    expect(hasPermission('sales_manager', P.BOOKINGS_READ_ALL)).toBe(true);
    expect(hasPermission('sales_manager', P.BOOKINGS_OVERRIDE)).toBe(true);
    expect(hasPermission('sales_manager', P.PLANS_MANAGE)).toBe(true);
    expect(hasPermission('sales_manager', P.RECEIPTS_REVERSE)).toBe(false);
    expect(hasPermission('sales_manager', P.DISCOUNT_UNLIMITED)).toBe(false);
    expect(hasPermission('sales_manager', P.ACCOUNTS_SETTINGS)).toBe(false);
    expect(hasPermission('admin', P.DISCOUNT_UNLIMITED)).toBe(true);
    expect(hasPermission('client', P.BOOKINGS_READ)).toBe(false);
  });

  it('discount cap per role; unlimited permission lifts it', () => {
    const s = { discountLimitBps: { sales_executive: 100, sales_manager: 300 } };
    const u = (role, perms = []) => ({ role, permissions: new Set(perms) });
    expect(discountCapBps(s, u('sales_executive'))).toBe(100);
    expect(discountCapBps(s, u('sales_manager'))).toBe(300);
    expect(discountCapBps(s, u('admin', [P.DISCOUNT_UNLIMITED]))).toBeNull();
    expect(discountCapBps(s, u('unknown'))).toBe(0);
  });

  it('Idempotency-Key header', () => {
    const run = (value) => {
      const req = { get: () => value };
      let called = false;
      idempotencyKey(req, {}, () => {
        called = true;
      });
      return { called, key: req.idempotencyKey };
    };
    expect(run(undefined)).toEqual({ called: true, key: null });
    expect(run('3f2a9c1e-7b4d-4e8a-9c1e-0a1b2c3d4e5f')).toEqual({
      called: true,
      key: '3f2a9c1e-7b4d-4e8a-9c1e-0a1b2c3d4e5f',
    });
    expect(() => run('short')).toThrow(
      expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' }),
    );
    expect(() => run('has space in it')).toThrow();
  });

  it('receipts accept only the reversal stamp; the ledger accepts nothing', async () => {
    const orgId = id();
    await expect(
      Receipt.updateOne({ orgId, _id: id() }, { $set: { amount: 1 } }),
    ).rejects.toMatchObject({
      code: 'RECEIPT_IMMUTABLE',
    });
    await expect(
      Receipt.updateMany({ orgId }, { $set: { status: 'reversed' } }),
    ).rejects.toMatchObject({
      code: 'RECEIPT_IMMUTABLE',
    });
    await expect(Receipt.deleteOne({ orgId, _id: id() })).rejects.toMatchObject({
      code: 'RECEIPT_IMMUTABLE',
    });
    await expect(LedgerEntry.updateOne({ orgId }, { $set: { amount: 1 } })).rejects.toMatchObject({
      code: 'LEDGER_IMMUTABLE',
    });
    await expect(LedgerEntry.deleteMany({ orgId })).rejects.toMatchObject({
      code: 'LEDGER_IMMUTABLE',
    });
  });

  it('booking documents validate; schedule items need a positive amount', async () => {
    const b = new Booking({
      orgId: id(),
      bookingNo: 'LVR-BK-00001',
      seq: 1,
      projectId: id(),
      blockId: id(),
      unitId: id(),
      unitCode: 'A-5B',
      kind: 'apartment',
      customerId: id(),
      customerName: 'Abdur Rahim',
      soldBy: id(),
      bookingDate: parseDhakaDate('2026-10-14'),
      price: {
        listTotal: 100,
        baseAmount: 100,
        contractTotal: 100,
        lines: [{ code: 'base', amount: 100 }],
      },
      schedule: [{ seq: 1, code: 'booking_money', label: 'Booking money', amount: 100 }],
    });
    await expect(b.validate()).resolves.toBeUndefined();
    b.schedule[0].amount = 0;
    await expect(b.validate()).rejects.toHaveProperty(['errors', 'schedule.0.amount']);
  });
});
