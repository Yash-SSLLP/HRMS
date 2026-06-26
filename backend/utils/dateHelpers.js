// Count calendar days inclusive between two dates (both required).
// Half-day requests are handled separately by the caller.
function daysInclusive(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  s.setHours(0, 0, 0, 0);
  e.setHours(0, 0, 0, 0);
  const ms = e.getTime() - s.getTime();
  if (ms < 0) return 0;
  return Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
}

function currentYear() {
  return new Date().getFullYear();
}

// ---------------------------------------------------------------------------
// IST (Asia/Kolkata) day helpers. The deployed backend runs in UTC, but this
// is an India-only HRMS, so "the day" must be anchored to the IST calendar day
// — not the server's timezone. Otherwise a punch made in the evening/early
// morning IST can be filed under the wrong (UTC) day and not surface on the
// website's "today" views. IST is UTC+5:30 with no DST, so a fixed offset is
// safe; we use it via an ISO literal so the result is timezone-independent.
const IST_TZ = 'Asia/Kolkata';

// 'YYYY-MM-DD' for the IST calendar day that `date` falls in.
function ymdIST(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(new Date(date));
}

// The exact instant of 00:00 IST for the IST day that `date` falls in, as a
// real Date (stored/compared in UTC under the hood). Server-timezone agnostic.
function startOfDayIST(date = new Date()) {
  return new Date(`${ymdIST(date)}T00:00:00+05:30`);
}

// [start, end) instants spanning the given IST month (month is 1-12).
function monthRangeIST(year, month) {
  const y = Number(year);
  const m = Number(month);
  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(`${y}-${pad(m)}-01T00:00:00+05:30`);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = new Date(`${nextY}-${pad(nextM)}-01T00:00:00+05:30`);
  return { start, end };
}

module.exports = { daysInclusive, currentYear, ymdIST, startOfDayIST, monthRangeIST };
