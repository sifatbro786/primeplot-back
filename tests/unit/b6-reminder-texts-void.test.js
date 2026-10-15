import { describe, expect, it } from 'vitest';

/** Owner additions 2026-10-16: editable reminder texts, co-applicant reminders, manual void. */
const t = await import('#modules/reminders/reminderText.js');
const rem = await import('#modules/reminders/reminder.service.js');
const { zSettingsPatch } = await import('#modules/accounts/accounts.validation.js');
const { reminderSettingsOf } = await import('#modules/accounts/accounts.service.js');
const { hasPermission, P } = await import('#shared/auth/permissions.js');

const LINK = 'http://localhost:3000/bn/portal/bookings/000000000000000000000000';

describe('reminder texts', () => {
  it('fills every placeholder; Bangla texts get Bangla digits in the amount', () => {
    const v = {
      company: 'শাপলা',
      name: 'রহিম',
      amount: '1,00,000',
      unit: 'A-1',
      date: '০৫/১০/২০২৬',
      link: 'x',
    };
    expect(t.renderReminderSms('{company} {name} ৳{amount} {unit} {date} {link}', v, 'bn')).toBe(
      'শাপলা রহিম ৳১,০০,০০০ A-1 ০৫/১০/২০২৬ x',
    );
    expect(t.renderReminderSms('Tk {amount}', { amount: '5,000' }, 'en')).toBe('Tk 5,000');
  });

  it('built-in texts are unchanged (REMINDER_SMS still renders them)', () => {
    const en = rem.REMINDER_SMS.en.upcoming({
      company: 'Shapla',
      name: 'Rahim',
      unit: 'A-1',
      amount: '5,000',
      date: '5 Oct 2026',
      url: 'x',
    });
    expect(en).toBe('Shapla: Dear Rahim, Tk 5,000 for A-1 is due on 5 Oct 2026. Details: x');
  });

  it('own text wins, empty falls back to the built-in one', () => {
    const texts = t.reminderTextsOf({ overdue: { bn: 'আমাদের নিজের লেখা {name}', en: '  ' } });
    expect(t.reminderTemplate(texts, 'overdue', 'bn')).toBe('আমাদের নিজের লেখা {name}');
    expect(t.reminderTemplate(texts, 'overdue', 'en')).toBe(t.DEFAULT_REMINDER_TEXTS.overdue.en);
    expect(texts.today).toEqual({ bn: null, en: null });
  });

  it('unknown placeholders and over-long texts are not ok', () => {
    expect(t.unknownPlaceholders('Hi {name}, call {phone} {phone}')).toEqual(['phone']);
    const bad = t.checkReminderSms('Dear {name}, {balance} due', {
      locale: 'en',
      company: 'X',
      link: LINK,
    });
    expect(bad.ok).toBe(false);
    const long = t.checkReminderSms('প্রিয় {name}, '.repeat(40), {
      locale: 'bn',
      company: 'X',
      link: LINK,
    });
    expect(long.segments).toBeGreaterThan(t.REMINDER_MAX_SEGMENTS);
    expect(long.ok).toBe(false);
  });

  it('every built-in text fits with long sample values', () => {
    for (const kind of t.REMINDER_KINDS) {
      for (const locale of ['bn', 'en']) {
        const r = t.checkReminderSms(t.DEFAULT_REMINDER_TEXTS[kind][locale], {
          locale,
          company: 'শাপলা প্রপার্টিজ লিমিটেড',
          link: LINK,
        });
        expect(r.ok, `${kind}/${locale}`).toBe(true);
      }
    }
  });
});

describe('reminder settings', () => {
  it('co-applicants off by default; texts null = built-in', () => {
    const r = reminderSettingsOf({});
    expect(r.coApplicants).toBe(false);
    expect(r.texts.upcoming).toEqual({ bn: null, en: null });
    expect(r.defaultTexts.today.en).toContain('{amount}');
  });

  it('patch: texts replace all six; empty → null; too short refused', () => {
    const ok = zSettingsPatch.safeParse({
      version: 0,
      reminders: {
        coApplicants: true,
        texts: { overdue: { bn: '', en: 'Pay {amount} please, {name}' } },
      },
    });
    expect(ok.success).toBe(true);
    expect(ok.data.reminders.texts).toEqual({
      upcoming: { bn: null, en: null },
      today: { bn: null, en: null },
      overdue: { bn: null, en: 'Pay {amount} please, {name}' },
    });
    expect(
      zSettingsPatch.safeParse({
        version: 0,
        reminders: { texts: { today: { bn: 'ছোট', en: null } } },
      }).success,
    ).toBe(false);
    expect(
      zSettingsPatch.safeParse({
        version: 0,
        reminders: { texts: { later: { bn: null, en: null } } },
      }).success,
    ).toBe(false);
  });
});

describe('manual document void', () => {
  it('admin only', () => {
    expect(hasPermission('admin', P.DOCUMENTS_VOID)).toBe(true);
    expect(hasPermission('sales_manager', P.DOCUMENTS_VOID)).toBe(false);
    expect(hasPermission('sales_executive', P.DOCUMENTS_VOID)).toBe(false);
  });
});
