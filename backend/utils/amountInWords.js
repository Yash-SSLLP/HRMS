/**
 * Rupee amounts spelled out in the Indian numbering system (crore / lakh /
 * thousand / hundred), for the "Salary in words" line on the salary slip.
 *
 * Payroll stores whole rupees everywhere (every component is Math.round-ed), so
 * this deliberately handles integers only — a fractional input is rounded first
 * rather than spelled out as paise.
 */

const ONES = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
];
const TENS = [
  '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
];

// 0-99 in words ('' for zero, so callers can skip empty groups).
function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

// 0-999 in words ('' for zero).
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} HUNDRED`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * Spell a whole-rupee amount in Indian-system words, upper case.
 * e.g. 166467 -> 'ONE LAKH SIXTY SIX THOUSAND FOUR HUNDRED SIXTY SEVEN RUPEES ONLY'
 * @param {number} amount - rupees; non-integers are rounded, negatives get a MINUS prefix
 * @returns {string} the words, always ending in 'RUPEES ONLY'
 */
function amountInWords(amount) {
  const n = Math.round(Number(amount) || 0);
  if (n === 0) return 'ZERO RUPEES ONLY';
  const sign = n < 0 ? 'MINUS ' : '';
  let rest = Math.abs(n);

  // Indian grouping: crore (10^7) and lakh (10^5) are two-digit groups, the
  // trailing thousand/hundred/units block is three digits.
  const crore = Math.floor(rest / 10000000); rest %= 10000000;
  const lakh = Math.floor(rest / 100000); rest %= 100000;
  const thousand = Math.floor(rest / 1000); rest %= 1000;

  const parts = [];
  // Crores can exceed 99 (e.g. 250 crore), so spell that group in full.
  if (crore) parts.push(`${crore > 99 ? threeDigits(crore) : twoDigits(crore)} CRORE`);
  if (lakh) parts.push(`${twoDigits(lakh)} LAKH`);
  if (thousand) parts.push(`${twoDigits(thousand)} THOUSAND`);
  if (rest) parts.push(threeDigits(rest));

  return `${sign}${parts.join(' ')} RUPEES ONLY`;
}

module.exports = { amountInWords };
