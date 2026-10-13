import { generateKeyBetween } from 'fractional-indexing';

/**
 * Fractional ranks for drag-and-drop ordering (Kanban columns). A rank is a short string compared
 * in plain binary order; a new rank always fits between two others, so a move writes ONE
 * document instead of renumbering the column. Prepending/appending stays short (≈4 characters
 * after 100,000 new leads at the top of a column).
 *
 *   rankBetween(null, null)   → first rank in an empty list
 *   rankBetween(null, first)  → before the first item (new leads go to the top)
 *   rankBetween(last, null)   → after the last item
 *   rankBetween(a, b)         → strictly between a and b (a < b)
 *
 * Mongo compares strings by byte value unless a collation is set — never sort ranks with one.
 */
export const RANK_RE = /^[0-9A-Za-z]{2,64}$/;

export function rankBetween(a = null, b = null) {
  // fractional-indexing ≥3.3 silently swaps out-of-order neighbours. A swapped pair means the
  // caller's view of the column is stale, so refuse instead of writing a rank in the wrong place.
  if (a !== null && b !== null && a >= b) {
    throw new RangeError(`rankBetween: "${a}" must sort before "${b}"`);
  }
  return generateKeyBetween(a, b);
}
