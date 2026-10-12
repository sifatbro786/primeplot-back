import { describe, expect, it } from 'vitest';
import {
  divRound,
  hasMaxDecimals,
  landAmount,
  landArea,
  landQuantity,
  sqftAmount,
  sqftArea,
} from '#shared/utils/area.js';
import { priceApartment, pricePlot, priceUnit } from '#modules/units/pricing.js';
import {
  canTransition,
  effectiveStatus,
  publicStatus,
  sourcesOf,
} from '#modules/units/unitStatus.js';

const TK = 100; // ৳1 = 100 poisha

describe('area conversion', () => {
  it('katha ↔ decimal ↔ sq ft (BD standard)', () => {
    expect(landArea(1, 'katha')).toEqual({
      value: 1,
      unit: 'katha',
      katha: 1,
      decimal: 1.6529,
      sqft: 720,
      sqm: 66.89,
    });
    expect(landArea(1, 'decimal')).toMatchObject({ katha: 0.605, decimal: 1, sqft: 435.6 });
    expect(landArea(5, 'katha')).toMatchObject({ decimal: 8.2645, sqft: 3600 });
    expect(landArea(3.3, 'decimal')).toMatchObject({ katha: 1.9965, sqft: 1437.48 });
  });

  it('keeps the entered (deed) value untouched', () => {
    const a = landArea(3.3, 'decimal');
    expect(a.value).toBe(3.3);
    expect(a.decimal).toBe(3.3);
  });

  it('rejects more than 4 decimals for land, 2 for sq ft', () => {
    expect(() => landArea(1.23456, 'katha')).toThrow(RangeError);
    expect(() => sqftArea(1250.123)).toThrow(RangeError);
    expect(hasMaxDecimals(0.1 + 0.2, 4)).toBe(true); // float noise is fine
  });

  it('sq ft → sq m', () => {
    expect(sqftArea(1250)).toEqual({ sqft: 1250, sqm: 116.13 });
    expect(sqftArea(1000.5).sqm).toBe(92.95);
  });

  it('quantity in the rate unit', () => {
    expect(landQuantity(landArea(5, 'katha'), 'decimal')).toBe(8.2645);
    expect(landQuantity(landArea(5, 'katha'), 'katha')).toBe(5);
  });
});

describe('exact money', () => {
  it('divRound rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
  });

  it('cross-unit land price has no float drift', () => {
    // 3.30 decimal at ৳12,00,000 per katha = 1.9965 katha → ৳23,95,800 exactly
    expect(landAmount(1_200_000 * TK, landArea(3.3, 'decimal'), 'katha')).toBe(2_395_800 * TK);
    // 5 katha at ৳7,26,000 per decimal = 8.264462… decimal → rounded once to the poisha
    expect(landAmount(726_000 * TK, landArea(5, 'katha'), 'decimal')).toBe(600_000_000);
  });

  it('sq ft price', () => {
    expect(sqftAmount(8_500 * TK, 1250)).toBe(10_625_000 * TK);
    expect(sqftAmount(8_500 * TK, 1250.5)).toBe(10_629_250 * TK);
  });
});

describe('apartment pricing', () => {
  const pricing = {
    ratePerSqft: 8_500 * TK,
    floorRise: { fromFloor: 3, perFloorPerSqft: 100 * TK },
    facingPremiums: [{ facing: 'south', perSqft: 200 * TK }],
    cornerPerSqft: 150 * TK,
    parkingPerSlot: 400_000 * TK,
    charges: [{ code: 'utility', label: 'Utility connection', amount: 150_000 * TK }],
  };
  const unit = {
    kind: 'apartment',
    floor: 5,
    saleableSqft: 1250,
    facing: 'south',
    isCorner: true,
    parkingSlots: 1,
  };

  it('itemises every line and the total adds up', () => {
    const p = priceApartment(unit, pricing);
    const by = Object.fromEntries(p.lines.map((l) => [l.code, l.amount]));
    expect(by.base).toBe(10_625_000 * TK);
    expect(by.floor_rise).toBe(375_000 * TK); // 3 steps × ৳100 × 1250
    expect(by.facing).toBe(250_000 * TK);
    expect(by.corner).toBe(187_500 * TK);
    expect(by.parking).toBe(400_000 * TK);
    expect(by['charge:utility']).toBe(150_000 * TK);
    expect(p.total).toBe(p.lines.reduce((s, l) => s + l.amount, 0));
    expect(p.total).toBe(11_987_500 * TK);
  });

  it('no floor rise below fromFloor; override replaces the rate; adjustment applies', () => {
    const p = priceApartment(
      {
        ...unit,
        floor: 2,
        isCorner: false,
        parkingSlots: 0,
        facing: null,
        rateOverride: 9_000 * TK,
        priceAdjustment: { amount: -50_000 * TK, note: 'Launch' },
      },
      pricing,
    );
    expect(p.lines.map((l) => l.code)).toEqual(['base', 'charge:utility', 'adjustment']);
    expect(p.total).toBe((11_250_000 + 150_000 - 50_000) * TK);
  });

  it('returns null when not priceable', () => {
    expect(priceApartment({ ...unit, saleableSqft: null }, pricing)).toBeNull();
    expect(priceUnit(unit, null)).toBeNull();
    expect(priceUnit(unit, {})).toBeNull();
  });
});

describe('plot pricing', () => {
  const pricing = {
    rateUnit: 'katha',
    rate: 2_500_000 * TK,
    roadWidthPremiums: [
      { minWidthFt: 25, perUnit: 100_000 * TK },
      { minWidthFt: 40, perUnit: 250_000 * TK },
    ],
    facingPremiums: [{ facing: 'south', perUnit: 50_000 * TK }],
    cornerPremiumBps: 1000, // 10 %
    charges: [{ code: 'development', label: 'Development charge', amount: 200_000 * TK }],
  };
  const plot = {
    kind: 'plot',
    landArea: landArea(3, 'katha'),
    roadWidthFt: 40,
    facing: 'south',
    isCorner: true,
  };

  it('base, best road tier, facing, corner %, charges', () => {
    const p = pricePlot(plot, pricing);
    const by = Object.fromEntries(p.lines.map((l) => [l.code, l.amount]));
    expect(by.base).toBe(7_500_000 * TK);
    expect(by.road_width).toBe(750_000 * TK); // 40 ft tier
    expect(by.facing).toBe(150_000 * TK);
    expect(by.corner).toBe(750_000 * TK);
    expect(p.total).toBe((7_500_000 + 750_000 + 150_000 + 750_000 + 200_000) * TK);
    expect(p.rateUnit).toBe('katha');
  });

  it('decimal-entered plot priced per katha', () => {
    const p = pricePlot({ kind: 'plot', landArea: landArea(5, 'decimal') }, pricing);
    expect(p.lines[0]).toMatchObject({ qty: 3.025, qtyUnit: 'katha' });
    expect(p.lines[0].amount).toBe(7_562_500 * TK);
  });

  it('narrow road gets no tier', () => {
    const p = pricePlot({ ...plot, roadWidthFt: 20, isCorner: false, facing: null }, pricing);
    expect(p.lines.map((l) => l.code)).toEqual(['base', 'charge:development']);
  });
});

describe('status machine', () => {
  it('allowed and forbidden transitions', () => {
    expect(canTransition('available', 'held')).toBe(true);
    expect(canTransition('held', 'booked')).toBe(true);
    expect(canTransition('booked', 'available')).toBe(false);
    expect(canTransition('blocked', 'held')).toBe(false);
    expect(canTransition('handed_over', 'cancelled')).toBe(false);
    expect(sourcesOf('available').sort()).toEqual(['blocked', 'cancelled', 'held']);
  });

  it('expired hold reads as available; public vocabulary hides blocked', () => {
    const past = { status: 'held', hold: { until: new Date(Date.now() - 1000) } };
    const future = { status: 'held', hold: { until: new Date(Date.now() + 60_000) } };
    expect(effectiveStatus(past)).toBe('available');
    expect(effectiveStatus(future)).toBe('held');
    expect(publicStatus('blocked')).toBe('unavailable');
    expect(publicStatus('registered')).toBe('sold');
  });
});
