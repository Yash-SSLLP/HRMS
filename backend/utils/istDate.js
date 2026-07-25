/**
 * IST calendar-date helpers.
 *
 * The company operates in IST but the server may run anywhere (Railway runs
 * UTC), so `Date#getMonth()/getDate()` is the wrong way to ask "what calendar day
 * is this?" — it answers in the server's timezone. A date entered as an IST
 * calendar day is stored 5h30 earlier in UTC, so on a UTC server every such date
 * reads back one day early and 1st-of-month dates fall into the previous month
 * (which silently hid birthdays / work anniversaries from the month calendar).
 *
 * Reading the parts in IST is correct for BOTH storage conventions in this
 * codebase — a date stored as UTC midnight ('YYYY-MM-DD' from a date input) is
 * 05:30 IST the same day, and one stored as IST midnight is IST midnight — so
 * these helpers should be used for every calendar-day decision.
 */
const IST_TZ = 'Asia/Kolkata';

const PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * Calendar year/month/day of an instant, as seen in IST.
 * @param {Date|string|number} date
 * @returns {{y: number, m: number, d: number}} month is 1-based
 */
function istParts(date) {
  const parts = PARTS_FMT.formatToParts(new Date(date));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * Month/day only — for matching recurring occasions (birthdays, anniversaries).
 * @returns {{m: number, d: number}}
 */
function istMonthDay(date) {
  const { m, d } = istParts(date);
  return { m, d };
}

/**
 * 'YYYY-MM-DD' for an instant, in IST.
 * @returns {string}
 */
function istDateString(date = new Date()) {
  // en-CA formats as ISO-like YYYY-MM-DD.
  return PARTS_FMT.format(new Date(date));
}

/**
 * Start/end instants of one IST calendar day, for inclusive range queries.
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {[Date, Date]}
 */
function istDayRange(dateStr) {
  return [new Date(`${dateStr}T00:00:00+05:30`), new Date(`${dateStr}T23:59:59.999+05:30`)];
}

/**
 * Start (inclusive) and end (exclusive) instants of an IST calendar month.
 * @param {number} year
 * @param {number} month - 1-based
 * @returns {[Date, Date]}
 */
function istMonthRange(year, month) {
  const pad = (n) => String(n).padStart(2, '0');
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  return [
    new Date(`${year}-${pad(month)}-01T00:00:00+05:30`),
    new Date(`${nextY}-${pad(nextM)}-01T00:00:00+05:30`),
  ];
}

module.exports = { IST_TZ, istParts, istMonthDay, istDateString, istDayRange, istMonthRange };
