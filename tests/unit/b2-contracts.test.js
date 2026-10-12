import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signRevalidation } from '#integrations/revalidate/index.js';
import {
  signAccessToken,
  signSocketToken,
  verifyAccessToken,
  verifySocketToken,
} from '#modules/auth/token.service.js';
import { zHotspot } from '#modules/floorplans/floorplan.service.js';
import { zApartmentPricing, zPlotPricing } from '#modules/projects/project.validation.js';
import { zBlockUnit, zUnitCreate } from '#modules/units/unit.validation.js';

describe('revalidation signature', () => {
  it('is HMAC-SHA256 over "<ts>.<body>"', () => {
    const body = JSON.stringify({ tags: ['projects'] });
    const secret = 's'.repeat(32);
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex');
    expect(signRevalidation(body, 1700000000, secret)).toBe(`sha256=${expected}`);
  });
});

describe('socket token', () => {
  const user = {
    id: '64b000000000000000000001',
    _id: '64b000000000000000000001',
    orgId: '64b0000000000000000000aa',
    role: 'admin',
    authVersion: 3,
  };
  it('round-trips and is not interchangeable with an access token', () => {
    const t = signSocketToken({ user, orgId: user.orgId });
    expect(verifySocketToken(t)).toMatchObject({ sub: user.id, org: user.orgId, av: 3 });
    expect(() => verifyAccessToken(t)).toThrow();
    const access = signAccessToken({ user, sessionId: '64b0000000000000000000bb' });
    expect(() => verifySocketToken(access)).toThrow(/socket/i);
  });
});

describe('B2 request schemas', () => {
  const tri = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];
  it('hotspots: 0–1 coordinates, one target at most', () => {
    expect(zHotspot.safeParse({ key: 'a', position: 'b', points: tri }).data.position).toBe('B');
    expect(
      zHotspot.safeParse({
        key: 'a',
        points: [
          [0, 0],
          [1.1, 0],
          [1, 1],
        ],
      }).success,
    ).toBe(false);
    expect(zHotspot.safeParse({ key: 'a', points: tri.slice(0, 2) }).success).toBe(false);
    expect(
      zHotspot.safeParse({
        key: 'a',
        position: 'A',
        unitId: '64b000000000000000000001',
        points: tri,
      }).success,
    ).toBe(false);
  });

  it('rate cards are strict per kind; money is integer poisha', () => {
    expect(zApartmentPricing.safeParse({ ratePerSqft: 850000 }).success).toBe(true);
    expect(zApartmentPricing.safeParse({ ratePerSqft: 8500.5 }).success).toBe(false);
    expect(zApartmentPricing.safeParse({ rate: 1 }).success).toBe(false); // plot field
    expect(zPlotPricing.safeParse({ rate: 1 }).success).toBe(false); // rateUnit required
    expect(
      zPlotPricing.safeParse({
        rateUnit: 'decimal',
        rate: 1,
        roadWidthPremiums: [
          { minWidthFt: 20, perUnit: 1 },
          { minWidthFt: 20, perUnit: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it('unit areas: ≤ 2 decimals sq ft, ≤ 4 decimals land; block reason "other" needs a note', () => {
    const b = '64b000000000000000000001';
    expect(zUnitCreate.safeParse({ blockId: b, saleableSqft: 1250.25 }).success).toBe(true);
    expect(zUnitCreate.safeParse({ blockId: b, saleableSqft: 1250.255 }).success).toBe(false);
    expect(
      zUnitCreate.safeParse({ blockId: b, landArea: { value: 3.3, unit: 'decimal' } }).success,
    ).toBe(true);
    expect(
      zUnitCreate.safeParse({ blockId: b, landArea: { value: 3.3, unit: 'bigha' } }).success,
    ).toBe(false);
    expect(zUnitCreate.safeParse({ blockId: b, status: 'booked' }).success).toBe(false); // never via body
    expect(zBlockUnit.safeParse({ reason: 'other' }).success).toBe(false);
    expect(zBlockUnit.safeParse({ reason: 'other', note: 'Owner request' }).success).toBe(true);
  });
});
