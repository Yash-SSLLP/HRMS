// Format a duration given in minutes as HH:MM (e.g. 90 → "01:30").
// Used for "late by" durations shown to HR/admin. This is a DURATION, not a
// time-of-day, so it stays 24h HH:MM (the 12-hour AM/PM rule is for clock times).
export function minutesToHHMM(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
