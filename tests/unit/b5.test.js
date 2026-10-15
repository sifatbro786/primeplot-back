import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { parseDhakaDate } from '#shared/utils/dhakaDate.js';

/** B5 pure logic: identifiers, masking, SSLCommerz helpers, reminder planning, schemas, texts. */
vi.hoisted(() => {
  process.env.SSLCZ_STORE_ID = 'teststore';
  process.env.SSLCZ_STORE_PASS = 'teststore@ssl';
});

const { parseIdentifier } = await import('#modules/auth/auth.service.js');
const { maskEmail, maskPhone, linkUrl } = await import('#modules/auth/authLinks.js');
const sslcz = await import('#integrations/payments/sslcommerz.js');
const rem = await import('#modules/reminders/reminder.service.js');
const { diffProfile } = await import('#modules/portal/portal.service.js');
const v = await import('#modules/portal/portal.validation.js');
const { zSettingsPatch } = await import('#modules/accounts/accounts.validation.js');
const { reminderSettingsOf, portalSettingsOf } =
  await import('#modules/accounts/accounts.service.js');
const { monthsBetween } = await import('#modules/analytics/analytics.service.js');
const { renderEmail } = await import('#integrations/email/templates.js');
const { newTranId, returnUrl } = await import('#modules/payments/payment.service.js');
const { hasPermission, P } = await import('#shared/auth/permissions.js');

const TK = 100;
const id = () => new mongoose.Types.ObjectId();

describe('sign-in identifier (B5)', () => {
  it('e-mail or Bangladesh / international phone', () => {
    expect(parseIdentifier(' Rahim@Example.com ')).toEqual({ email: 'rahim@example.com' });
    expect(parseIdentifier('01712-345678')).toEqual({ phone: '+8801712345678' });
    expect(parseIdentifier('০১৭১২৩৪৫৬৭৮')).toEqual({ phone: '+8801712345678' });
    expect(parseIdentifier('+44 7700 900123')).toEqual({ phone: '+447700900123' });
    expect(parseIdentifier('hello')).toEqual({ phone: null });
  });

  it('masks phone and e-mail; links carry the locale', () => {
    expect(maskPhone('+8801712345678')).toBe('+880 17••••5678');
    expect(maskPhone(null)).toBeNull();
    expect(maskEmail('rahim@example.com')).toBe('ra•••@example.com');
    expect(linkUrl('account_setup', 'en', 'tok')).toBe(
      'http://localhost:3000/en/setup-account?token=tok',
    );
    expect(linkUrl('password_reset', 'bn', 'tok')).toBe(
      'http://localhost:3000/bn/reset-password?token=tok',
    );
  });

  it('portal permissions: managers manage, executives do not, clients only use', () => {
    expect(hasPermission('sales_manager', P.PORTAL_MANAGE)).toBe(true);
    expect(hasPermission('sales_manager', P.ONLINE_PAYMENTS_REVIEW)).toBe(true);
    expect(hasPermission('sales_executive', P.PORTAL_MANAGE)).toBe(false);
    expect(hasPermission('client', P.PORTAL_MANAGE)).toBe(false);
    expect(hasPermission('admin', P.ANALYTICS_READ)).toBe(true);
  });
});

describe('SSLCommerz helpers', () => {
  it('taka strings ↔ poisha, exactly', () => {
    expect(sslcz.toTakaString(1234550)).toBe('12345.50');
    expect(sslcz.toTakaString(5)).toBe('0.05');
    expect(sslcz.parseTaka('12345.50')).toBe(1234550);
    expect(sslcz.parseTaka('12345.5')).toBe(1234550);
    expect(sslcz.parseTaka('12345')).toBe(1234500);
    expect(sslcz.parseTaka('100.0000')).toBe(10000);
    expect(sslcz.parseTaka('100.005')).toBeNull(); // sub-poisha
    expect(sslcz.parseTaka('1e5')).toBeNull();
    expect(sslcz.parseTaka(null)).toBeNull();
    expect(() => sslcz.toTakaString(-1)).toThrow();
  });

  it('normalises a validation reply', () => {
    const t = sslcz.normalizeTxn({
      status: 'VALID',
      tran_id: 'PP1',
      val_id: 'v1',
      amount: '1500.00',
      currency: 'BDT',
      currency_type: 'BDT',
      currency_amount: '1500.00',
      risk_level: '0',
      bank_tran_id: 'B1',
      card_type: 'BKASH-BKash',
    });
    expect(t).toMatchObject({
      status: 'VALID',
      amount: 150000,
      currencyAmount: 150000,
      riskLevel: 0,
      cardType: 'BKASH-BKash',
    });
  });

  it('verify_sign: md5 over the listed keys + md5(store password)', () => {
    const body = { tran_id: 'PP1', val_id: 'v1', amount: '10.00', status: 'VALID' };
    const keys = 'amount,status,tran_id,val_id';
    const data = { ...body, store_passwd: createHash('md5').update('teststore@ssl').digest('hex') };
    const str = Object.keys(data)
      .sort()
      .map((k) => `${k}=${data[k]}`)
      .join('&');
    const sign = createHash('md5').update(str).digest('hex');
    expect(sslcz.verifySignature(null, { ...body, verify_key: keys, verify_sign: sign })).toBe(
      true,
    );
    expect(
      sslcz.verifySignature(null, {
        ...body,
        amount: '99.00',
        verify_key: keys,
        verify_sign: sign,
      }),
    ).toBe(false);
    expect(sslcz.verifySignature(null, body)).toBe(false);
  });

  it('tran ids are unique, 26 chars; return URLs land on the portal', () => {
    const a = newTranId();
    expect(a).toMatch(/^PP[0-9A-F]{24}$/);
    expect(newTranId()).not.toBe(a);
    const p = { _id: 'abc', locale: 'en' };
    expect(returnUrl(p, 'success')).toBe(
      'http://localhost:3000/en/portal/payments/abc?result=success',
    );
    expect(returnUrl(null, 'fail')).toBe('http://localhost:3000/bn/portal');
  });
});

describe('reminder planning (B5.3)', () => {
  const rules = reminderSettingsOf({}).rules; // −7, 0, +3, +15
  const item = (seq, due, amount, paid = 0) => ({
    _id: id(),
    seq,
    code: 'installment',
    label: `Installment ${seq}`,
    dueDate: due ? parseDhakaDate(due) : null,
    amount,
    paid,
  });
  const booking = (schedule, extra = {}) => ({
    _id: id(),
    bookingNo: 'LVR-BK-00001',
    unitCode: 'A-1',
    projectId: id(),
    customerId: id(),
    status: 'active',
    schedule,
    ...extra,
  });

  it('windows: each rule fires up to 2 days late, never into the next rule', () => {
    const w = rem.ruleWindows(rules).map(({ key, from, to }) => [key, from, to]);
    expect(w).toEqual([
      ['before_7', -7, -5],
      ['due_day', 0, 2],
      ['overdue_3', 3, 5],
      ['overdue_15', 15, 17],
    ]);
    const tight = rem.ruleWindows([
      { key: 'a', offsetDays: 0, enabled: true },
      { key: 'b', offsetDays: 1, enabled: true },
      { key: 'c', offsetDays: 9, enabled: false },
    ]);
    expect(tight.map((x) => [x.key, x.from, x.to])).toEqual([
      ['a', 0, 0],
      ['b', 1, 3],
    ]);
  });

  it('picks the right rule, sums items due the same day, skips paid / undated / cancelled', () => {
    const today = '2026-10-20';
    const b1 = booking([
      item(1, '2026-10-27', 100 * TK), // 7 days ahead → before_7
      item(2, '2026-10-20', 50 * TK), // today → due_day
      item(3, '2026-10-20', 25 * TK, 5 * TK), // same day, partly paid → summed (20)
      item(4, '2026-10-17', 30 * TK), // 3 days late → overdue_3
      item(5, '2026-10-10', 10 * TK), // 10 days late → no rule
      item(6, '2026-10-05', 40 * TK, 40 * TK), // paid
      item(7, null, 99 * TK), // milestone not called
    ]);
    const cancelled = booking([item(1, '2026-10-20', 10 * TK)], { status: 'cancelled' });
    const plans = rem.planReminders([b1, cancelled], rules, today);
    const got = plans.map((p) => [p.rule.key, p.dueDate, p.kind, p.amount]);
    expect(got).toEqual([
      ['overdue_3', '2026-10-17', 'overdue', 30 * TK],
      ['due_day', '2026-10-20', 'today', 70 * TK],
      ['before_7', '2026-10-27', 'upcoming', 100 * TK],
    ]);
    expect(plans[0].totalOverdue).toBe(40 * TK); // items 4 + 5
  });

  it('catch-up: 6 days before still sends "before_7"; 1 day late still "due_day"', () => {
    const b = booking([item(1, '2026-10-26', 10 * TK), item(2, '2026-10-19', 10 * TK)]);
    const got = rem.planReminders([b], rules, '2026-10-20').map((p) => p.rule.key);
    expect(got.sort()).toEqual(['before_7', 'due_day']);
  });

  it('all rules off → nothing', () => {
    const off = rules.map((r) => ({ ...r, enabled: false }));
    expect(rem.planReminders([booking([item(1, '2026-10-20', TK)])], off, '2026-10-20')).toEqual(
      [],
    );
  });

  it('texts: Bangla digits and dates, English dates', () => {
    expect(rem.displayDate('2026-10-05', 'en')).toBe('5 Oct 2026');
    expect(rem.displayDate('2026-10-05', 'bn')).toBe('০৫/১০/২০২৬');
    const bn = rem.REMINDER_SMS.bn.overdue({
      company: 'শাপলা',
      name: 'রহিম',
      unit: 'A-1',
      amount: '1,00,000',
      date: '০৫/১০/২০২৬',
      url: 'x',
    });
    expect(bn).toContain('৳১,০০,০০০');
    const en = rem.REMINDER_SMS.en.upcoming({
      company: 'Shapla',
      name: 'Rahim',
      unit: 'A-1',
      amount: '5,000',
      date: '5 Oct 2026',
      url: 'x',
    });
    expect(en).toBe('Shapla: Dear Rahim, Tk 5,000 for A-1 is due on 5 Oct 2026. Details: x');
    expect(rem.kindOf(-1)).toBe('upcoming');
    expect(rem.kindOf(0)).toBe('today');
    expect(rem.kindOf(4)).toBe('overdue');
  });

  it('dhakaHour is UTC+6', () => {
    expect(rem.dhakaHour(new Date('2026-10-20T04:30:00Z'))).toBe(10);
  });
});

describe('portal profile requests', () => {
  const c = { phone: '+8801712345678', email: 'a@b.com', presentAddress: 'Old', altPhone: null };

  it('keeps only real changes, normalises phones', () => {
    const r = diffProfile(c, {
      phone: '01712345678',
      presentAddress: 'New road',
      email: 'A@B.com',
    });
    expect(r.changes).toEqual({ presentAddress: 'New road' });
    expect(r.before).toEqual({ presentAddress: 'Old' });
    const r2 = diffProfile(c, { altPhone: '01812345678', email: '' });
    expect(r2.changes).toEqual({ altPhone: '+8801812345678', email: null });
  });

  it('refuses no-ops, bad phones and removing the phone', () => {
    expect(() => diffProfile(c, { presentAddress: 'Old' })).toThrow(
      expect.objectContaining({ code: 'NO_CHANGES' }),
    );
    expect(() => diffProfile(c, { phone: '12345' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PHONE' }),
    );
    expect(() => diffProfile(c, { phone: '' })).toThrow(
      expect.objectContaining({ code: 'PHONE_REQUIRED' }),
    );
  });

  it('only contact fields are accepted from the portal', () => {
    expect(v.zProfileRequest.safeParse({ presentAddress: 'x' }).success).toBe(true);
    expect(v.zProfileRequest.safeParse({ name: 'New Name' }).success).toBe(false);
    expect(v.zProfileRequest.safeParse({ nid: '1234567890' }).success).toBe(false);
  });
});

describe('schemas', () => {
  const slip = {
    amount: 50_000 * TK,
    paidOn: '2026-10-14',
    channel: 'bank_transfer',
    bankAccountId: String(id()),
    reference: 'TRX1',
    mediaId: String(id()),
  };

  it('slip: bank transfer needs the account and a reference; pay order needs neither', () => {
    expect(v.zSlipCreate.safeParse(slip).success).toBe(true);
    expect(v.zSlipCreate.safeParse({ ...slip, reference: undefined }).success).toBe(false);
    expect(v.zSlipCreate.safeParse({ ...slip, bankAccountId: null }).success).toBe(false);
    expect(
      v.zSlipCreate.safeParse({
        ...slip,
        channel: 'pay_order',
        bankAccountId: null,
        reference: undefined,
      }).success,
    ).toBe(true);
    expect(v.zSlipCreate.safeParse({ ...slip, amount: 0 }).success).toBe(false);
    expect(v.zSlipCreate.safeParse({ ...slip, extra: 1 }).success).toBe(false);
  });

  it('settings: portal + reminder rules (unique keys and days)', () => {
    const ok = zSettingsPatch.safeParse({
      version: 0,
      portal: { autoInvite: false, onlineMinAmount: 500 * TK },
      reminders: {
        sendHour: 9,
        rules: [
          { key: 'before_3', offsetDays: -3 },
          { key: 'overdue_7', offsetDays: 7, sms: false },
        ],
      },
    });
    expect(ok.success).toBe(true);
    expect(ok.data.reminders.rules[0]).toEqual({
      key: 'before_3',
      offsetDays: -3,
      enabled: true,
      sms: true,
      email: true,
    });
    const dupDay = zSettingsPatch.safeParse({
      version: 0,
      reminders: {
        rules: [
          { key: 'a', offsetDays: 1 },
          { key: 'b', offsetDays: 1 },
        ],
      },
    });
    expect(dupDay.success).toBe(false);
    expect(zSettingsPatch.safeParse({ version: 0, reminders: { sendHour: 3 } }).success).toBe(
      false,
    );
    expect(zSettingsPatch.safeParse({ version: 0, portal: { unknown: true } }).success).toBe(false);
  });

  it('settings defaults fill old documents', () => {
    expect(portalSettingsOf({})).toMatchObject({
      autoInvite: true,
      autoInviteCoApplicants: false,
      onlineMinAmount: 100_000,
    });
    const r = reminderSettingsOf({
      reminders: {
        enabled: false,
        rules: [
          { key: 'x', offsetDays: 5 },
          { key: 'y', offsetDays: -2 },
        ],
      },
    });
    expect(r.enabled).toBe(false);
    expect(r.rules.map((x) => x.key)).toEqual(['y', 'x']); // sorted by day
  });
});

describe('analytics + e-mail', () => {
  it('months between, inclusive, across a year end', () => {
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthsBetween('2026-03-01', '2026-03-31')).toEqual(['2026-03']);
  });

  it('reminder e-mail renders both languages, escaped', () => {
    const d = {
      orgName: 'Shapla',
      name: '<Rahim>',
      kind: 'overdue',
      bookingNo: 'LVR-BK-00001',
      unit: 'A-1',
      project: 'Lake View',
      amount: '1,00,000',
      dueDate: '5 Oct 2026',
      items: [{ label: 'Installment 3', amount: '1,00,000', dueDate: '5 Oct 2026' }],
      totalOverdue: '2,00,000',
      url: 'http://localhost:3000/en/portal',
    };
    const en = renderEmail('installment_reminder', 'en', d);
    expect(en.subject).toBe('Payment overdue — LVR-BK-00001 — Shapla');
    expect(en.html).toContain('&lt;Rahim&gt;');
    expect(en.html).toContain('Tk 2,00,000');
    const bn = renderEmail('installment_reminder', 'bn', { ...d, kind: 'upcoming' });
    expect(bn.subject).toContain('কিস্তির রিমাইন্ডার');
    expect(bn.html).toContain('৳১,০০,০০০');
    const notice = renderEmail('notice', 'bn', {
      orgName: 'X',
      name: 'R',
      subject: 'S',
      lines: ['<b>'],
    });
    expect(notice.html).toContain('&lt;b&gt;');
  });
});
