/**
 * Unit status machine (ARCHITECTURE §5). Enforced in the service layer with atomic
 * conditional updates — the `from` state is part of the update filter, so two racing
 * requests can never both win.
 *
 *   available → held → booked → allotted → registered → handed_over
 *   available → booked (walk-in)          booked/allotted → cancelled → available
 *   available ⇄ blocked (reason required)  held → available (release / expiry)
 */
export const UNIT_STATUSES = Object.freeze([
  'available',
  'held',
  'booked',
  'allotted',
  'registered',
  'handed_over',
  'cancelled',
  'blocked',
]);

export const TRANSITIONS = Object.freeze({
  available: Object.freeze(['held', 'booked', 'blocked']),
  held: Object.freeze(['available', 'booked']),
  booked: Object.freeze(['allotted', 'cancelled']),
  allotted: Object.freeze(['registered', 'cancelled']),
  registered: Object.freeze(['handed_over']),
  handed_over: Object.freeze([]),
  cancelled: Object.freeze(['available']),
  blocked: Object.freeze(['available']),
});

/** Sold = a booking exists. Price-affecting fields are locked from here on (snapshot in B4). */
export const SOLD_STATUSES = Object.freeze(['booked', 'allotted', 'registered', 'handed_over']);

export const BLOCK_REASONS = Object.freeze([
  'landowner_share',
  'management_reserve',
  'legal_issue',
  'not_for_sale',
  'other',
]);

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Every state that may move to `to`. */
export function sourcesOf(to) {
  return UNIT_STATUSES.filter((s) => TRANSITIONS[s].includes(to));
}

export const isSold = (status) => SOLD_STATUSES.includes(status);

/** A hold whose time has passed counts as available everywhere (lazy expiry on read). */
export function effectiveStatus(unit, now = new Date()) {
  if (unit.status === 'held' && (!unit.hold?.until || new Date(unit.hold.until) <= now)) {
    return 'available';
  }
  return unit.status;
}

/**
 * Public vocabulary (website, public socket): blocked/cancelled units never leak details.
 *   available | held | sold | unavailable
 */
export function publicStatus(status) {
  if (status === 'available') return 'available';
  if (status === 'held') return 'held';
  if (isSold(status)) return 'sold';
  return 'unavailable'; // blocked, cancelled (being re-listed)
}
