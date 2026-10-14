/**
 * Receipt allocation (ARCHITECTURE §5) — pure functions, integer poisha.
 *
 * A receipt pays the OLDEST unpaid schedule items first: items with a due date in date order
 * (sequence breaks ties), then items without a date yet (milestones not called) in sequence
 * order. Paying more than what is due today therefore pre-pays the next items — an advance —
 * and a partial payment leaves the last touched item partly paid. More than the whole
 * outstanding balance is refused (no unallocated credit).
 */

const time = (d) => (d ? new Date(d).getTime() : null);

/** Schedule items in allocation order (a new array; inputs untouched). */
export function allocationOrder(items) {
  return [...items].sort((a, b) => {
    const ta = time(a.dueDate);
    const tb = time(b.dueDate);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
    return a.seq - b.seq;
  });
}

export const remainingOf = (item) => Math.max(0, item.amount - (item.paid ?? 0));

export function outstandingOf(items) {
  return items.reduce((s, i) => s + remainingOf(i), 0);
}

/**
 * Split `amount` over the unpaid items. Returns [{ itemId, seq, code, label, amount }].
 * Throws RangeError OVERPAYMENT when amount > outstanding.
 */
export function allocate(items, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('INVALID_AMOUNT');
  const outstanding = outstandingOf(items);
  if (amount > outstanding) {
    const err = new RangeError('OVERPAYMENT');
    err.outstanding = outstanding;
    throw err;
  }
  let left = amount;
  const out = [];
  for (const item of allocationOrder(items)) {
    if (!left) break;
    const take = Math.min(remainingOf(item), left);
    if (!take) continue;
    out.push({
      itemId: item._id,
      seq: item.seq,
      code: item.code,
      label: item.label ?? null,
      amount: take,
    });
    left -= take;
  }
  return out;
}

/**
 * Totals for a schedule as of a Dhaka date ('YYYY-MM-DD').
 *   total, paid, outstanding, dueNow (unpaid on items due on/before asOf), overdue (before asOf)
 */
export function scheduleTotals(items, asOf) {
  const asOfT = Date.parse(`${asOf}T00:00:00+06:00`);
  let total = 0;
  let paid = 0;
  let dueNow = 0;
  let overdue = 0;
  let nextDue = null;
  for (const i of items) {
    total += i.amount;
    paid += i.paid ?? 0;
    const rem = remainingOf(i);
    const t = time(i.dueDate);
    if (!rem || t === null) continue;
    if (t <= asOfT) dueNow += rem;
    if (t < asOfT) overdue += rem;
    if (t > asOfT && (nextDue === null || t < time(nextDue.dueDate))) nextDue = i;
  }
  return {
    total,
    paid,
    outstanding: total - paid,
    dueNow,
    overdue,
    nextDue: nextDue
      ? { itemId: String(nextDue._id), dueDate: nextDue.dueDate, amount: remainingOf(nextDue) }
      : null,
  };
}

/** Item state for display. */
export function itemStatus(item, asOf) {
  const rem = remainingOf(item);
  if (!rem) return 'paid';
  const t = time(item.dueDate);
  const asOfT = Date.parse(`${asOf}T00:00:00+06:00`);
  if (t === null) return item.paid ? 'partial' : 'not_called';
  if (t < asOfT) return 'overdue';
  if (t === asOfT) return 'due';
  return item.paid ? 'partial' : 'upcoming';
}
