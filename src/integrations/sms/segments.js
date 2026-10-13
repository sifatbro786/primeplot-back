/**
 * SMS length maths (GSM 03.38 / 3GPP TS 23.038).
 *
 * A message is sent as GSM-7 when every character is in the GSM basic set or its extension
 * table; anything else (Bangla, emoji, curly quotes) switches the WHOLE message to UCS-2.
 *   GSM-7: 160 septets in one SMS; 153 per segment when split. Extension chars (€ [ ] { } ~ ^ | \)
 *          take 2 septets and an escape pair is never split across segments.
 *   UCS-2: 70 UTF-16 units in one SMS; 67 per segment when split. A surrogate pair (emoji) is
 *          never split across segments.
 * Operators bill per segment, so `segments` is what the cost preview multiplies.
 */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('\f^{}\\[~]|€');

export const LIMITS = Object.freeze({
  gsm7: { single: 160, multi: 153 },
  ucs2: { single: 70, multi: 67 },
});

/** Cost of each character in its encoding's units, or null when GSM-7 can't carry it. */
function gsmCost(ch) {
  if (GSM_BASIC.has(ch)) return 1;
  if (GSM_EXTENDED.has(ch)) return 2;
  return null;
}

/** Split `costs` (units per character) into segments of at most `size` units, never splitting a character. */
function pack(costs, size) {
  let segments = 1;
  let used = 0;
  for (const c of costs) {
    if (used + c > size) {
      segments += 1;
      used = 0;
    }
    used += c;
  }
  return segments;
}

/**
 * @returns {{ encoding: 'gsm7'|'ucs2', chars: number, units: number, segments: number,
 *             perSegment: number, remaining: number }}
 *   chars = what a person counts; units = septets (GSM-7) or UTF-16 code units (UCS-2);
 *   remaining = units left in the last segment before another one starts.
 */
export function analyzeSms(text) {
  const s = String(text ?? '');
  const chars = [...s];
  const gsm = chars.map(gsmCost);
  const isGsm = gsm.every((c) => c !== null);
  const encoding = isGsm ? 'gsm7' : 'ucs2';
  const costs = isGsm ? gsm : chars.map((ch) => ch.length); // surrogate pair = 2 units
  const units = costs.reduce((a, b) => a + b, 0);
  const lim = LIMITS[encoding];

  if (units === 0) {
    return {
      encoding,
      chars: 0,
      units: 0,
      segments: 0,
      perSegment: lim.single,
      remaining: lim.single,
    };
  }
  if (units <= lim.single) {
    return {
      encoding,
      chars: chars.length,
      units,
      segments: 1,
      perSegment: lim.single,
      remaining: lim.single - units,
    };
  }
  const segments = pack(costs, lim.multi);
  // Units used in the last segment (re-pack to find it exactly).
  let used = 0;
  for (const c of costs) used = used + c > lim.multi ? c : used + c;
  return {
    encoding,
    chars: chars.length,
    units,
    segments,
    perSegment: lim.multi,
    remaining: lim.multi - used,
  };
}

/** Segment analysis + cost in poisha (null when the per-segment price is not configured). */
export function smsCost(text, costPerSegmentPoisha) {
  const a = analyzeSms(text);
  return {
    ...a,
    costPoisha: costPerSegmentPoisha == null ? null : a.segments * costPerSegmentPoisha,
  };
}
