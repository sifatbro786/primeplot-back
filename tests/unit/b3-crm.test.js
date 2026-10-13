import { describe, expect, it } from 'vitest';
import { normalizePhone } from '#shared/utils/phone.js';
import { rankBetween, RANK_RE } from '#shared/utils/rank.js';
import { slaDueAt } from '#modules/leads/sla.js';
import {
  zActivityCreate,
  zLeadCreate,
  zLeadMove,
  zPublicLead,
  zSettingsPatch,
  zStagesReplace,
  zTaskCreate,
} from '#modules/leads/lead.validation.js';
import { hasPermission, P } from '#shared/auth/permissions.js';

const ID = 'a'.repeat(24);
const dhaka = (s) => new Date(`${s}+06:00`);
const local = (d) =>
  new Date(d.getTime() + 6 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
const SLA = {
  enabled: true,
  firstResponseMinutes: 30,
  officeStart: '09:00',
  officeEnd: '20:00',
  weekend: [5],
};

describe('fractional ranks', () => {
  it('stays ordered under random inserts', () => {
    const list = [];
    for (let i = 0; i < 3000; i += 1) {
      const p = Math.floor(Math.random() * (list.length + 1));
      const r = rankBetween(list[p - 1] ?? null, list[p] ?? null);
      expect(RANK_RE.test(r)).toBe(true);
      if (p > 0) expect(list[p - 1] < r).toBe(true);
      if (p < list.length) expect(r < list[p]).toBe(true);
      list.splice(p, 0, r);
    }
  });

  it('stays short when every new lead goes to the top of a column', () => {
    let top = null;
    for (let i = 0; i < 20_000; i += 1) top = rankBetween(null, top);
    expect(top.length).toBeLessThanOrEqual(6);
  });

  it('rejects out-of-order neighbours', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    expect(() => rankBetween(b, a)).toThrow();
  });
});

describe('first-response SLA (office hours, Asia/Dhaka)', () => {
  it.each([
    ['2026-10-13T10:00', '2026-10-13 10:30'], // Tuesday, office hours
    ['2026-10-13T19:50', '2026-10-14 09:20'], // spills into the next morning
    ['2026-10-13T23:30', '2026-10-14 09:30'], // night
    ['2026-10-13T06:00', '2026-10-13 09:30'], // before opening
    ['2026-10-15T19:45', '2026-10-17 09:15'], // Thursday evening → Friday off → Saturday
    ['2026-10-16T12:00', '2026-10-17 09:30'], // Friday
  ])('%s → due %s', (at, due) => {
    expect(local(slaDueAt(dhaka(at), SLA))).toBe(due);
  });

  it('is off when disabled or when no working day exists', () => {
    expect(slaDueAt(dhaka('2026-10-13T10:00'), { ...SLA, enabled: false })).toBeNull();
    expect(
      slaDueAt(dhaka('2026-10-13T10:00'), { ...SLA, weekend: [0, 1, 2, 3, 4, 5, 6] }),
    ).toBeNull();
    expect(
      slaDueAt(dhaka('2026-10-13T10:00'), { ...SLA, officeStart: '20:00', officeEnd: '09:00' }),
    ).toBeNull();
  });
});

describe('lead phones', () => {
  it('normalizes BD mobiles and accepts international numbers (NRB buyers)', () => {
    expect(normalizePhone('01712-345678')).toBe('+8801712345678');
    expect(normalizePhone('০১৭১২৩৪৫৬৭৮')).toBe('+8801712345678');
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567');
    expect(normalizePhone('00447911123456')).toBe('+447911123456');
  });
  it('rejects junk and invalid BD numbers', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+88012345678')).toBeNull(); // +880 must be a valid BD mobile
    expect(normalizePhone('abc')).toBeNull();
  });
});

describe('CRM request schemas', () => {
  it('public form: website contract, defaults, strict', () => {
    const ok = zPublicLead.parse({
      name: 'Rahim',
      phone: '01712345678',
      source: 'website',
      page: '/bn',
      hp: '',
      elapsedMs: 4000,
    });
    expect(ok.type).toBe('buyer');
    expect(
      zPublicLead.safeParse({ name: 'Rahim', phone: '01712345678', isAdmin: true }).success,
    ).toBe(false);
    expect(
      zPublicLead.safeParse({ name: 'Rahim', phone: '01712345678', source: 'facebook' }).success,
    ).toBe(false);
    expect(zPublicLead.safeParse({ name: 'R', phone: '01712345678' }).success).toBe(false);
    expect(zPublicLead.safeParse({ name: 'Rahim', phone: '017', email: '' }).success).toBe(false);
  });

  it('landowner form takes land details', () => {
    const r = zPublicLead.parse({
      type: 'landowner',
      name: 'Karim',
      phone: '01812345678',
      land: {
        location: 'Bashundhara',
        area: { value: 5, unit: 'katha' },
        roadWidthFt: 30,
        ownership: 'inherited',
        mutation: 'done',
      },
    });
    expect(r.land.area.unit).toBe('katha');
  });

  it('manual lead: website is not a manual source; budget order checked', () => {
    expect(
      zLeadCreate.safeParse({ name: 'Rahim', phone: '01712345678', source: 'website' }).success,
    ).toBe(false);
    expect(
      zLeadCreate.safeParse({
        name: 'Rahim',
        phone: '01712345678',
        interest: { budgetMin: 500, budgetMax: 100 },
      }).success,
    ).toBe(false);
    expect(zLeadCreate.parse({ name: 'Rahim', phone: '01712345678' }).source).toBe('manual');
  });

  it('move needs a version; activity note needs text; task reminder options', () => {
    expect(zLeadMove.safeParse({ stageId: ID }).success).toBe(false);
    expect(zActivityCreate.safeParse({ type: 'note' }).success).toBe(false);
    expect(zActivityCreate.safeParse({ type: 'call', outcome: 'no_answer' }).success).toBe(true);
    expect(
      zTaskCreate.parse({ title: 'Call back', dueAt: '2026-10-14T10:00:00+06:00' })
        .remindMinutesBefore,
    ).toBe(15);
    expect(
      zTaskCreate.safeParse({ title: 'Call back', dueAt: '2026-10-14', remindMinutesBefore: 7 })
        .success,
    ).toBe(false);
  });

  it('pipeline and settings shapes', () => {
    expect(
      zStagesReplace.safeParse({ pipeline: 'buyer', stages: [{ name: 'A', kind: 'open' }] })
        .success,
    ).toBe(false);
    expect(zSettingsPatch.safeParse({ version: 0, sla: { officeStart: '9:00' } }).success).toBe(
      false,
    );
    expect(
      zSettingsPatch.safeParse({
        version: 0,
        assignment: {
          projectPools: [
            { projectId: ID, userIds: [ID] },
            { projectId: ID, userIds: [ID] },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe('CRM permissions', () => {
  it('executives own leads; managers see all, assign and manage the pipeline', () => {
    expect(hasPermission('sales_executive', P.LEADS_READ_OWN)).toBe(true);
    expect(hasPermission('sales_executive', P.LEADS_READ_ALL)).toBe(false);
    expect(hasPermission('sales_executive', P.LEADS_ASSIGN)).toBe(false);
    expect(hasPermission('sales_manager', P.LEADS_ASSIGN)).toBe(true);
    expect(hasPermission('sales_manager', P.PIPELINE_MANAGE)).toBe(true);
    expect(hasPermission('client', P.LEADS_READ_OWN)).toBe(false);
  });
});
