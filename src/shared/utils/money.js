/**
 * Money helpers (ARCHITECTURE §5): amounts are integer poisha (৳1 = 100). Display only — never
 * parse these strings back into numbers.
 *
 *   formatTaka(12550000000)        → '1,25,50,000.00'   (lakh/crore grouping)
 *   amountInWords(12550000050,'en') → 'One Crore Twenty-Five Lakh Fifty Thousand Taka and Fifty Poisha Only'
 *   amountInWords(12550000000,'bn') → 'এক কোটি পঁচিশ লক্ষ পঞ্চাশ হাজার টাকা মাত্র'
 */

const BN_DIGIT_CHARS = '০১২৩৪৫৬৭৮৯';

export function toBnDigits(s) {
  return String(s).replace(/\d/g, (d) => BN_DIGIT_CHARS[d]);
}

function assertPoisha(poisha) {
  if (!Number.isSafeInteger(poisha)) throw new TypeError('Amount must be integer poisha');
}

/** Lakh/crore grouping of a non-negative integer string: 125500000 → 12,55,00,000. */
function groupIndian(intStr) {
  if (intStr.length <= 3) return intStr;
  const last3 = intStr.slice(-3);
  const rest = intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** '1,25,50,000.00' (no currency sign). `{ bn: true }` → Bangla digits. */
export function formatTaka(poisha, { bn = false, decimals = true } = {}) {
  assertPoisha(poisha);
  const neg = poisha < 0;
  const abs = Math.abs(poisha);
  const taka = Math.floor(abs / 100);
  const ps = abs % 100;
  let out = groupIndian(String(taka));
  if (decimals) out += `.${String(ps).padStart(2, '0')}`;
  if (neg) out = `-${out}`;
  return bn ? toBnDigits(out) : out;
}

// ── English (Indian system) ──────────────────────────────────────────────────────

const EN_ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen',
  'Nineteen',
]; // prettier-ignore
const EN_TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function en99(n) {
  if (n < 20) return EN_ONES[n];
  const t = EN_TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${EN_ONES[n % 10]}` : t;
}

function en999(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(`${EN_ONES[h]} Hundred`);
  if (r) parts.push(en99(r));
  return parts.join(' ');
}

/** Indian-system words for a non-negative integer (crore part may itself exceed 99). */
function enWords(n) {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (crore) parts.push(`${enWords(crore)} Crore`);
  if (lakh) parts.push(`${en99(lakh)} Lakh`);
  if (thousand) parts.push(`${en99(thousand)} Thousand`);
  if (rest) parts.push(en999(rest));
  return parts.join(' ');
}

// ── Bangla ───────────────────────────────────────────────────────────────────────

const BN_0_99 = [
  'শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
  'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
  'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আটাশ', 'ঊনত্রিশ',
  'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'ঊনচল্লিশ',
  'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'ঊনপঞ্চাশ',
  'পঞ্চাশ', 'একান্ন', 'বাহান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'ঊনষাট',
  'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'ঊনসত্তর',
  'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিয়াত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'ঊনআশি',
  'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'আটাশি', 'ঊননব্বই',
  'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
]; // prettier-ignore

function bnWords(n) {
  if (n === 0) return BN_0_99[0];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  const parts = [];
  if (crore) parts.push(`${bnWords(crore)} কোটি`);
  if (lakh) parts.push(`${BN_0_99[lakh]} লক্ষ`);
  if (thousand) parts.push(`${BN_0_99[thousand]} হাজার`);
  if (hundred) parts.push(`${BN_0_99[hundred]} শত`);
  if (rest) parts.push(BN_0_99[rest]);
  return parts.join(' ');
}

/** Amount in words for receipts and letters. Negative amounts are refused. */
export function amountInWords(poisha, locale = 'en') {
  assertPoisha(poisha);
  if (poisha < 0) throw new RangeError('Amount in words needs a non-negative amount');
  const taka = Math.floor(poisha / 100);
  const ps = poisha % 100;
  if (locale === 'bn') {
    const t = `${bnWords(taka)} টাকা`;
    return ps ? `${t} ${BN_0_99[ps]} পয়সা মাত্র` : `${t} মাত্র`;
  }
  const t = `${enWords(taka)} Taka`;
  return ps ? `${t} and ${en99(ps)} Poisha Only` : `${t} Only`;
}

/** `bps` (basis points, 10 000 = 100 %) of an amount, rounded half away from zero. */
export function bpsOf(amount, bps) {
  assertPoisha(amount);
  // BigInt: amount × bps can pass 2^53 for large contracts.
  const abs = BigInt(Math.abs(amount)) * BigInt(bps);
  const q = abs / 10_000n;
  const rounded = abs % 10_000n >= 5_000n ? q + 1n : q;
  return Math.sign(amount) * Number(rounded);
}
