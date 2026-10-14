import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { parseDhakaDate } from '#shared/utils/dhakaDate.js';
import { canonicalJson, contentHashOf, maskName } from '#modules/documents/document.service.js';
import { mainDate, renderDocumentHtml } from '#modules/documents/render/templates.js';
import { Document } from '#modules/documents/document.model.js';
import { agingOf } from '#modules/bookings/report.service.js';
import {
  zCancel,
  zChargeCreate,
  zChequeCreate,
  zRefund,
  zReschedule,
  zTransfer,
} from '#modules/bookings/lifecycle.validation.js';
import { zBookingCreate } from '#modules/bookings/booking.validation.js';
import { zSettingsPatch } from '#modules/accounts/accounts.validation.js';
import { Cheque } from '#modules/accounts/cheque.model.js';
import { Booking } from '#modules/bookings/booking.model.js';

const TK = 100;
const LAKH = 100_000 * TK;
const id = () => new mongoose.Types.ObjectId();
const sid = () => String(id());

const SNAP = {
  org: { name: 'Shapla Developments', nameBn: 'শাপলা ডেভেলপমেন্টস', logoMediaId: null },
  project: { name: 'Lake View', nameBn: 'লেক ভিউ', code: 'LVR' },
  unit: { code: 'A-5B', kind: 'apartment', floor: 5, saleableSqft: 1250, saleableSqm: 116.13 },
  booking: { bookingNo: 'LVR-BK-00001', bookingDate: '2026-10-14', soldByName: 'Sumi' },
  holder: {
    customerNo: 'C-000001',
    name: 'Abdur Rahim',
    nameBn: 'আব্দুর রহিম',
    phone: '+8801712345678',
  },
  coApplicants: [],
  receipt: {
    receiptNo: 'LVR-2627-000001',
    date: '2026-10-14',
    amount: 5 * LAKH,
    mode: 'cash',
    allocations: [{ label: 'Booking money', labelBn: 'বুকিং মানি', amount: 5 * LAKH }],
    receivedByName: 'Nadia',
  },
  totals: { contract: 103 * LAKH, charges: 0, paidToDate: 5 * LAKH, outstanding: 98 * LAKH },
};

describe('document hashing and verification helpers', () => {
  it('canonical JSON ignores key order and undefined; the hash is stable', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    const a = contentHashOf({ type: 'receipt', number: 'X', snapshot: { x: 1, y: 2 } });
    const b = contentHashOf({ type: 'receipt', number: 'X', snapshot: { y: 2, x: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf({ type: 'receipt', number: 'X', snapshot: { x: 1, y: 3 } })).not.toBe(a);
  });

  it('masks names (Latin and Bangla) for the public page', () => {
    expect(maskName('Abdur Rahim')).toBe('A**** R****');
    expect(maskName('Al')).toBe('A**');
    expect(maskName('আব্দুর রহিম')).toMatch(/^আ\*+ র\*+$/);
    expect(maskName('')).toBe('');
  });

  it('main date per document type', () => {
    expect(mainDate('receipt', SNAP)).toBe('2026-10-14');
    expect(mainDate('booking_form', SNAP)).toBe('2026-10-14');
    expect(mainDate('statement', { asOf: '2026-12-01' })).toBe('2026-12-01');
  });
});

describe('document templates', () => {
  const render = (over = {}, locale = 'en') =>
    renderDocumentHtml({
      doc: {
        type: 'receipt',
        number: 'LVR-2627-000001',
        snapshot: SNAP,
        status: 'valid',
        contentHash: 'a'.repeat(64),
        createdAt: new Date('2026-10-14T06:00:00Z'),
        ...over,
      },
      locale,
      logo: null,
      verifyUrl: 'https://example.com/verify/abc',
      qrSvg: '<svg></svg>',
    });

  it('English receipt: number, amount, words, verify link, embedded fonts', () => {
    const html = render();
    expect(html).toContain('LVR-2627-000001');
    expect(html).toContain('৳ 5,00,000.00');
    expect(html).toContain('Five Lakh Taka Only');
    expect(html).toContain('https://example.com/verify/abc');
    expect(html).toContain("font-family:'Hind Siliguri'");
    expect(html).not.toContain('class="void"');
  });

  it('Bangla receipt uses Bangla digits, words and names', () => {
    const html = render({}, 'bn');
    expect(html).toContain('৳ ৫,০০,০০০.০০');
    expect(html).toContain('পাঁচ লক্ষ টাকা মাত্র');
    expect(html).toContain('আব্দুর রহিম');
    expect(html).toContain('মানি রসিদ');
    expect(html).toContain('১৪ অক্টোবর');
  });

  it('escapes every value and marks void documents', () => {
    const evil = {
      ...SNAP,
      holder: { ...SNAP.holder, name: '<script>alert(1)</script>', nameBn: null },
    };
    const html = render({ snapshot: evil, status: 'void' });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('class="void"');
  });
});

describe('aging buckets', () => {
  const item = (amount, due, paid = 0) => ({
    _id: id(),
    amount,
    paid,
    dueDate: due ? parseDhakaDate(due) : null,
  });
  it('splits overdue amounts by days past due; due today is not overdue', () => {
    const a = agingOf(
      [
        item(100, '2026-10-01', 40), // 30 days → 1–30 (60)
        item(200, '2026-09-30'), // 31 days → 31–60
        item(300, '2026-07-01'), // 92 days → 90+
        item(400, '2026-10-31'), // today
        item(500, null),
        item(600, '2026-08-15', 600), // paid
      ],
      '2026-10-31',
    );
    expect(a.buckets).toEqual({ d1_30: 60, d31_60: 200, d61_90: 0, d90_plus: 300 });
    expect(a.oldestDueDate).toBe('2026-07-01');
  });
});

describe('B4.2 request schemas', () => {
  it('cheque: number format, dates', () => {
    const c = { chequeNo: '0045123', bank: 'BRAC Bank', chequeDate: '2026-11-14', amount: LAKH };
    expect(zChequeCreate.safeParse(c).success).toBe(true);
    expect(zChequeCreate.safeParse({ ...c, chequeNo: '12' }).success).toBe(false);
    expect(zChequeCreate.safeParse({ ...c, chequeDate: '14/11/2026' }).success).toBe(false);
    expect(zChequeCreate.safeParse({ ...c, status: 'cleared' }).success).toBe(false);
  });

  it('booking money by cheque is accepted at booking', () => {
    const b = { unitId: sid(), customerId: sid(), planId: sid() };
    expect(
      zBookingCreate.safeParse({
        ...b,
        payment: {
          mode: 'cheque',
          chequeNo: '123456',
          bank: 'DBBL',
          chequeDate: '2026-10-20',
          amount: LAKH,
        },
      }).success,
    ).toBe(true);
    expect(
      zBookingCreate.safeParse({ ...b, payment: { mode: 'cheque', amount: LAKH } }).success,
    ).toBe(false);
  });

  it('charges: system kinds are not manual', () => {
    const c = { kind: 'delay', label: 'Delay charge', amount: 5000 * TK, dueDate: '2026-11-01' };
    expect(zChargeCreate.safeParse(c).success).toBe(true);
    expect(zChargeCreate.safeParse({ ...c, kind: 'cheque_bounce' }).success).toBe(false);
    expect(zChargeCreate.safeParse({ ...c, kind: 'transfer_fee' }).success).toBe(false);
  });

  it('reschedule: unique ids, reason, no charges', () => {
    const i = sid();
    const ok = {
      version: 1,
      reason: 'Customer asked',
      items: [{ id: i, code: 'booking_money', amount: 1 }],
    };
    expect(zReschedule.safeParse(ok).success).toBe(true);
    expect(zReschedule.safeParse({ ...ok, items: [ok.items[0], ok.items[0]] }).success).toBe(false);
    expect(zReschedule.safeParse({ ...ok, items: [{ code: 'charge', amount: 1 }] }).success).toBe(
      false,
    );
    expect(zReschedule.safeParse({ ...ok, reason: '' }).success).toBe(false);
  });

  it('transfer, cancel, refund', () => {
    const to = sid();
    expect(zTransfer.safeParse({ toCustomerId: to }).success).toBe(true);
    expect(zTransfer.safeParse({ toCustomerId: to, coApplicantIds: [to] }).success).toBe(false);
    expect(zCancel.safeParse({ reason: 'Moving abroad' }).success).toBe(true);
    expect(zCancel.safeParse({ reason: 'x' }).success).toBe(false);
    expect(zRefund.safeParse({ amount: LAKH, mode: 'cash' }).success).toBe(true);
    expect(zRefund.safeParse({ amount: LAKH, mode: 'cheque' }).success).toBe(false);
    expect(zRefund.safeParse({ amount: LAKH, mode: 'cheque', instrumentNo: '778' }).success).toBe(
      true,
    );
    expect(zRefund.safeParse({ amount: LAKH, mode: 'bank_transfer', reference: 'X' }).success).toBe(
      false,
    );
    expect(zSettingsPatch.safeParse({ version: 0, chequeBounceFee: 500 * TK }).success).toBe(true);
  });
});

describe('B4.2/B4.3 models', () => {
  it('cheque and booking documents validate', async () => {
    const c = new Cheque({
      orgId: id(),
      bookingId: id(),
      bookingNo: 'LVR-BK-00001',
      projectId: id(),
      unitCode: 'A-5B',
      customerId: id(),
      customerName: 'Abdur Rahim',
      chequeNo: '0045123',
      bank: 'BRAC Bank',
      chequeDate: parseDhakaDate('2026-11-14'),
      amount: LAKH,
      receivedDate: parseDhakaDate('2026-10-14'),
    });
    await expect(c.validate()).resolves.toBeUndefined();
    c.status = 'lost';
    await expect(c.validate()).rejects.toHaveProperty(['errors', 'status']);

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
      price: { listTotal: 100, baseAmount: 100, contractTotal: 100 },
      schedule: [
        { seq: 1, code: 'booking_money', label: 'Booking money', amount: 100 },
        { seq: 2, code: 'charge', chargeKind: 'delay', label: 'Delay', amount: 10 },
      ],
      stage: 'allotted',
      allotment: { date: parseDhakaDate('2026-10-20') },
      cancellation: null,
    });
    await expect(b.validate()).resolves.toBeUndefined();
    b.stage = 'sold';
    await expect(b.validate()).rejects.toHaveProperty(['errors', 'stage']);
  });

  it('issued documents only accept the void stamp and the PDF cache', async () => {
    const orgId = id();
    await expect(
      Document.updateOne({ orgId, _id: id() }, { $set: { snapshot: {} } }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IMMUTABLE' });
    await expect(Document.deleteOne({ orgId, _id: id() })).rejects.toMatchObject({
      code: 'DOCUMENT_IMMUTABLE',
    });
    await expect(
      Document.updateOne({ orgId, _id: id() }, { $unset: { verifyToken: 1 } }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IMMUTABLE' });
  });
});
