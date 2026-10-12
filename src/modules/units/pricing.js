import { landAmount, landQuantity, sqftAmount } from '#shared/utils/area.js';

/**
 * Pricing strategies (ARCHITECTURE §3.2) — pure functions, no I/O.
 * All money is integer poisha. Every line is rounded once; the total is the sum of lines, so
 * the breakdown always adds up exactly (this breakdown is what B4 freezes into a booking).
 *
 * Apartment (project.pricing):
 *   base        = rate/sft × saleable sft            (unit.rateOverride replaces the rate)
 *   floor_rise  = perFloorPerSqft × (floor − fromFloor + 1) × sft   for floor ≥ fromFloor
 *   facing      = facingPremiums[facing].perSqft × sft               (may be negative)
 *   corner      = cornerPerSqft × sft                                if unit.isCorner
 *   parking     = parkingPerSlot × unit.parkingSlots
 *   charge:*    = fixed per-unit charges (utility, generator, …)
 *   adjustment  = unit.priceAdjustment.amount                       (signed, one-off)
 *
 * Plot:
 *   base        = rate × area in rateUnit (katha | decimal, exact conversion)
 *   road_width  = best tier with minWidthFt ≤ road width → perUnit × area
 *   facing      = facingPremiums[facing].perUnit × area
 *   corner      = cornerPremiumBps / 10 000 × base                   if unit.isCorner
 *   charge:*, adjustment — as above
 */
export const FACINGS = Object.freeze([
  'north',
  'south',
  'east',
  'west',
  'north_east',
  'north_west',
  'south_east',
  'south_west',
]);

const line = (code, amount, extra = {}) => ({ code, amount, ...extra });

function finish(lines, meta) {
  const kept = lines.filter((l) => l.amount !== 0 || l.code === 'base');
  const total = kept.reduce((s, l) => s + l.amount, 0);
  return { currency: 'BDT', ...meta, lines: kept, total: Math.max(0, total) };
}

function chargeLines(pricing) {
  return (pricing.charges ?? []).map((c) =>
    line(`charge:${c.code}`, c.amount, { label: c.label, labelBn: c.labelBn ?? null }),
  );
}

function adjustmentLine(unit) {
  const adj = unit.priceAdjustment;
  return adj?.amount ? [line('adjustment', adj.amount, { note: adj.note ?? null })] : [];
}

export function priceApartment(unit, pricing) {
  const rate = unit.rateOverride ?? pricing?.ratePerSqft;
  const sqft = unit.saleableSqft;
  if (!rate || !sqft) return null; // "price on request"

  const lines = [line('base', sqftAmount(rate, sqft), { qty: sqft, qtyUnit: 'sqft', rate })];

  const fr = pricing.floorRise;
  if (fr?.perFloorPerSqft && Number.isInteger(unit.floor) && unit.floor >= fr.fromFloor) {
    const steps = unit.floor - fr.fromFloor + 1;
    lines.push(
      line('floor_rise', sqftAmount(fr.perFloorPerSqft * steps, sqft), {
        qty: sqft,
        qtyUnit: 'sqft',
        rate: fr.perFloorPerSqft * steps,
        steps,
      }),
    );
  }

  const facing = unit.facing && pricing.facingPremiums?.find((f) => f.facing === unit.facing);
  if (facing?.perSqft) {
    lines.push(
      line('facing', sqftAmount(facing.perSqft, sqft), {
        qty: sqft,
        qtyUnit: 'sqft',
        rate: facing.perSqft,
        facing: unit.facing,
      }),
    );
  }

  if (unit.isCorner && pricing.cornerPerSqft) {
    lines.push(
      line('corner', sqftAmount(pricing.cornerPerSqft, sqft), {
        qty: sqft,
        qtyUnit: 'sqft',
        rate: pricing.cornerPerSqft,
      }),
    );
  }

  const slots = unit.parkingSlots ?? 0;
  if (slots > 0 && pricing.parkingPerSlot) {
    lines.push(
      line('parking', pricing.parkingPerSlot * slots, {
        qty: slots,
        qtyUnit: 'slot',
        rate: pricing.parkingPerSlot,
      }),
    );
  }

  lines.push(...chargeLines(pricing), ...adjustmentLine(unit));
  return finish(lines, { strategy: 'apartment_sqft', rateUnit: 'sqft' });
}

export function pricePlot(unit, pricing) {
  const rate = unit.rateOverride ?? pricing?.rate;
  const rateUnit = pricing?.rateUnit;
  const area = unit.landArea;
  if (!rate || !rateUnit || !area?.value) return null;

  const qty = landQuantity(area, rateUnit);
  const base = landAmount(rate, area, rateUnit);
  const lines = [line('base', base, { qty, qtyUnit: rateUnit, rate })];

  if (unit.roadWidthFt != null && pricing.roadWidthPremiums?.length) {
    const tier = [...pricing.roadWidthPremiums]
      .filter((t) => t.minWidthFt <= unit.roadWidthFt)
      .sort((a, b) => b.minWidthFt - a.minWidthFt)[0];
    if (tier?.perUnit) {
      lines.push(
        line('road_width', landAmount(tier.perUnit, area, rateUnit), {
          qty,
          qtyUnit: rateUnit,
          rate: tier.perUnit,
          minWidthFt: tier.minWidthFt,
        }),
      );
    }
  }

  const facing = unit.facing && pricing.facingPremiums?.find((f) => f.facing === unit.facing);
  if (facing?.perUnit) {
    lines.push(
      line('facing', landAmount(facing.perUnit, area, rateUnit), {
        qty,
        qtyUnit: rateUnit,
        rate: facing.perUnit,
        facing: unit.facing,
      }),
    );
  }

  if (unit.isCorner && pricing.cornerPremiumBps) {
    // Integer math: base × bps / 10 000, half away from zero.
    const amt = Math.sign(base) * Math.round(Math.abs(base * pricing.cornerPremiumBps) / 10_000);
    lines.push(line('corner', amt, { bps: pricing.cornerPremiumBps }));
  }

  lines.push(...chargeLines(pricing), ...adjustmentLine(unit));
  return finish(lines, { strategy: 'plot_land', rateUnit });
}

/** Strategy dispatch by unit kind. Returns the breakdown, or null when not priceable yet. */
export function priceUnit(unit, pricing) {
  if (!pricing) return null;
  return unit.kind === 'plot' ? pricePlot(unit, pricing) : priceApartment(unit, pricing);
}
