/**
 * Area units (ARCHITECTURE §5, owner decision 2026-10-12).
 *
 *  - Plots: the deed figure is entered in katha OR decimal (শতাংশ) and kept as entered — that
 *    is the legal source of truth. Both units (+ sq ft, sq m) are derived and stored for display,
 *    filtering and sorting.
 *  - Apartments: sq ft is primary; sq m is derived and stored alongside.
 *
 * Bangladesh standard units: 1 katha = 720 sq ft, 1 decimal = 1/100 acre = 435.6 sq ft
 * (so 1 decimal = 0.605 katha exactly; 1 katha ≈ 1.6529 decimal). 1 sq ft = 0.09290304 m².
 *
 * Exactness: everything is computed on scaled integers (BigInt). A land value with ≤ 4 decimals
 * is turned into "tenths of a sq ft × 10⁴", which is exact for both units (katha = 7200,
 * decimal = 4356 tenths). Prices are then one integer multiply + one rounded division, so
 * "3.30 decimal at ৳X per katha" never drifts by a poisha.
 */
export const SQFT_PER_KATHA = 720;
export const SQFT_PER_DECIMAL = 435.6;
export const SQM_PER_SQFT = 0.09290304;
export const LAND_UNITS = Object.freeze(['katha', 'decimal']);

/** Tenths of a sq ft per land unit (integers → exact arithmetic). */
const TENTHS = Object.freeze({ katha: 7200n, decimal: 4356n, sqft: 10n });
const E4 = 10_000n;

/** Round-half-away-from-zero integer division for BigInt. */
export function divRound(num, den) {
  if (den === 0n) throw new RangeError('Division by zero');
  if (den < 0n) return divRound(-num, -den);
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a * 2n + den) / (2n * den);
  return neg ? -q : q;
}

/** Number → integer scaled by 10^dp, or null when it has more than `dp` decimals. */
export function toScaled(value, dp) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const f = 10 ** dp;
  const scaled = Math.round(value * f);
  // Allow float noise (e.g. 3.3 * 1e4 = 32999.999…), reject real extra precision.
  if (Math.abs(value * f - scaled) > 1e-6 * Math.max(1, Math.abs(value * f))) return null;
  return BigInt(scaled);
}

export const hasMaxDecimals = (value, dp) => toScaled(value, dp) !== null;

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Exact land measure: tenths of a sq ft × 10⁴ (BigInt). */
function landTenthsE4(value, unit) {
  const v = toScaled(value, 4);
  if (v === null) throw new RangeError('Land area allows at most 4 decimal places');
  const f = TENTHS[unit];
  if (!f || unit === 'sqft') throw new RangeError(`Unknown land unit: ${unit}`);
  return v * f;
}

/** Quantity of `unit` in the measure, as a Number rounded to `dp` decimals. */
function measureIn(tenthsE4, unit, dp) {
  const scaled = divRound(tenthsE4 * 10n ** BigInt(dp), TENTHS[unit] * E4);
  return Number(scaled) / 10 ** dp;
}

/**
 * Land area as stored on plots/projects:
 *   { value, unit, katha, decimal, sqft, sqm }
 * `value`/`unit` are the entered (deed) figures; the rest are derived (katha/decimal 4 dp,
 * sqft/sqm 2 dp).
 */
export function landArea(value, unit) {
  const m = landTenthsE4(value, unit);
  const sqft = measureIn(m, 'sqft', 2);
  return {
    value,
    unit,
    katha: unit === 'katha' ? value : measureIn(m, 'katha', 4),
    decimal: unit === 'decimal' ? value : measureIn(m, 'decimal', 4),
    sqft,
    sqm: round((Number(m) / 1e5) * SQM_PER_SQFT, 2),
  };
}

/** Apartment area: sq ft (≤ 2 dp) → { sqft, sqm }. */
export function sqftArea(sqft) {
  if (toScaled(sqft, 2) === null) throw new RangeError('Area allows at most 2 decimal places');
  return { sqft, sqm: round(sqft * SQM_PER_SQFT, 2) };
}

/**
 * Money for a land area at `ratePoisha` per `rateUnit` (katha | decimal), in integer poisha.
 * Exact: rate × measure / (unitTenths × 10⁴), rounded once.
 */
export function landAmount(ratePoisha, area, rateUnit) {
  const m = landTenthsE4(area.value, area.unit);
  return Number(divRound(BigInt(ratePoisha) * m, TENTHS[rateUnit] * E4));
}

/** Money for `sqft` (≤ 2 dp) at `ratePoisha` per sq ft, in integer poisha. */
export function sqftAmount(ratePoisha, sqft) {
  const s = toScaled(sqft, 2);
  if (s === null) throw new RangeError('Area allows at most 2 decimal places');
  return Number(divRound(BigInt(ratePoisha) * s, 100n));
}

/** Area quantity in `rateUnit` for display next to a price line (4 dp). */
export function landQuantity(area, rateUnit) {
  if (area.unit === rateUnit) return area.value;
  return measureIn(landTenthsE4(area.value, area.unit), rateUnit, 4);
}
