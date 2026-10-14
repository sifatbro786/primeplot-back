/**
 * Calendar dates in Bangladesh time (UTC+6, no DST). Business dates — booking date, due dates,
 * receipt dates — are calendar days, stored as the Date of 00:00 Dhaka time (the same rule as
 * project.handoverAt) and exchanged as 'YYYY-MM-DD'.
 */
const OFFSET_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' → Date at 00:00 Dhaka. */
export function parseDhakaDate(s) {
  return new Date(`${s}T00:00:00+06:00`);
}

/** Date → 'YYYY-MM-DD' in Dhaka time. */
export function toDhakaDate(date) {
  return new Date(new Date(date).getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Today in Dhaka as 'YYYY-MM-DD'. */
export function todayDhaka(now = new Date()) {
  return toDhakaDate(now);
}

/** { y, m (1-12), d } of a 'YYYY-MM-DD' string. */
export function partsOf(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Add calendar months; the day is clamped to the month's end (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(s, months) {
  const { y, m, d } = partsOf(s);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

export function addDays(s, days) {
  const t = Date.parse(`${s}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both 'YYYY-MM-DD'); negative when b is earlier. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/**
 * Fiscal year of a date (Bangladesh: July–June, org.settings.fiscalYearStartMonth).
 *   fiscalYear('2026-10-14', 7) → { startYear: 2026, label: '2026-27', short: '2627' }
 *   fiscalYear('2026-10-14', 1) → { startYear: 2026, label: '2026',    short: '2026' }
 */
export function fiscalYear(s, startMonth = 7) {
  const { y, m } = partsOf(s);
  const startYear = m >= startMonth ? y : y - 1;
  if (startMonth === 1) return { startYear, label: String(startYear), short: String(startYear) };
  const end2 = pad((startYear + 1) % 100);
  return {
    startYear,
    label: `${startYear}-${end2}`,
    short: `${pad(startYear % 100)}${end2}`,
  };
}
