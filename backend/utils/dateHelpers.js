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

module.exports = { daysInclusive, currentYear };
