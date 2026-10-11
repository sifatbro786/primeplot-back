/**
 * Bangladesh mobile numbers → E.164 (+8801XXXXXXXXX). The E.164 form is the lead-dedupe key.
 * Accepts: 01712345678, 8801712345678, +8801712345678, 008801712345678, with spaces/dashes/dots
 * and Bangla digits (০-৯). Operator prefixes 013–019.
 * Returns null when the input is not a valid BD mobile number.
 */
const BN_DIGITS = /[০-৯]/g;
const BD_MOBILE = /^(?:\+?880|00880|0)?(1[3-9]\d{8})$/;

export function normalizeBdPhone(input) {
  if (input == null) return null;
  const s = String(input)
    .replace(BN_DIGITS, (d) => String(d.charCodeAt(0) - 0x09e6))
    .replace(/[\s\-().]/g, '');
  const m = BD_MOBILE.exec(s);
  return m ? `+880${m[1]}` : null;
}

/** Display form: +880 1712-345678 */
export function formatBdPhone(e164) {
  const m = /^\+880(1\d{3})(\d{6})$/.exec(e164 ?? '');
  return m ? `+880 ${m[1]}-${m[2]}` : (e164 ?? '');
}
