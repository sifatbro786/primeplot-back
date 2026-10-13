/**
 * First-response deadline in office hours (pure; Asia/Dhaka is UTC+6 all year — no DST).
 *
 *   slaDueAt(createdAt, { firstResponseMinutes: 30, officeStart: '09:00', officeEnd: '20:00', weekend: [5] })
 *
 * A lead that arrives at 19:50 is due at 09:20 the next working day; one that arrives on Friday
 * (weekend) or at night is due 30 minutes after the next opening. Returns null when the SLA is off.
 */
const OFFSET_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function slaDueAt(from, sla) {
  if (!sla?.enabled) return null;
  const open = minutesOf(sla.officeStart);
  const close = minutesOf(sla.officeEnd);
  if (close <= open) return null; // misconfigured window → no SLA rather than a wrong one
  const weekend = new Set(sla.weekend ?? []);

  // Work in "local ms" (UTC ms + 6 h) so day boundaries are Dhaka midnights.
  let t = new Date(from).getTime() + OFFSET_MS;
  let left = sla.firstResponseMinutes * 60_000;

  for (let guard = 0; guard < 400 && left > 0; guard += 1) {
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    const dow = new Date(dayStart).getUTCDay();
    const winStart = dayStart + open * 60_000;
    const winEnd = dayStart + close * 60_000;
    if (weekend.has(dow) || t >= winEnd) {
      t = dayStart + DAY_MS; // next local midnight
      continue;
    }
    if (t < winStart) t = winStart;
    const take = Math.min(left, winEnd - t);
    t += take;
    left -= take;
  }
  return left > 0 ? null : new Date(t - OFFSET_MS);
}
