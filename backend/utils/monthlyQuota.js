/**
 * Part-month entitlement helpers, shared by payroll and leave so both modules
 * apply exactly the same rule.
 *
 * Monthly allowances (the 2 paid leave days, the 5 free late arrivals) are a FULL
 * month's entitlement. An employee who was only on the payroll for part of a
 * calendar month — a mid-month joiner or leaver — earns them in proportion to the
 * days they were actually there.
 *
 * Salary itself is spread over CALENDAR days (Sundays and holidays are paid), so
 * these helpers count calendar days too: a full July = 31 days, and joining on
 * 5 July leaves 27. The per-day pay rate always stays monthly-gross ÷ days-in-month,
 * so a day of leave or absence costs the same for a joiner as for anyone else.
 */
const { monthRangeIST, ymdIST } = require('./dateHelpers');

/**
 * Days in a calendar month that an employee was on the payroll — on/after their
 * joining date and on/before their exit date. Sundays and holidays count (they
 * are paid days).
 * @param {{dateOfJoining?: Date, dateOfExit?: Date}} profile
 * @param {number} year / @param {number} month - 1-12
 * @returns {{daysInMonth: number, eligibleDays: number, notEmployedDays: number}}
 */
function daysOnPayroll(profile, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const joinKey = profile && profile.dateOfJoining ? ymdIST(profile.dateOfJoining) : null;
  const exitKey = profile && profile.dateOfExit ? ymdIST(profile.dateOfExit) : null;
  if (!joinKey && !exitKey) {
    return { daysInMonth, eligibleDays: daysInMonth, notEmployedDays: 0 };
  }
  const { start } = monthRangeIST(year, month);
  let eligibleDays = 0;
  for (let i = 0; i < daysInMonth; i += 1) {
    // Midday IST anchor so the calendar day is unambiguous.
    const key = ymdIST(new Date(start.getTime() + i * 86400000 + 12 * 3600000));
    if (joinKey && key < joinKey) continue;   // before this employee joined
    if (exitKey && key > exitKey) continue;   // after they exited
    eligibleDays += 1;
  }
  return { daysInMonth, eligibleDays, notEmployedDays: daysInMonth - eligibleDays };
}

/**
 * A full month's allowance scaled to the days on the payroll, rounded to whole
 * days (leave and lateness are both counted in whole days). Joined 5 July →
 * 2 × 27/31 = 1.7 → 2 paid leaves, and 5 × 27/31 = 4.4 → 4 free late arrivals.
 * @param {number} full - the full-month entitlement
 * @param {number} eligibleDays / @param {number} daysInMonth - from daysOnPayroll
 * @returns {number} the prorated entitlement (never negative, never above `full`)
 */
function prorateAllowance(full, eligibleDays, daysInMonth) {
  if (!daysInMonth || eligibleDays >= daysInMonth) return full;
  return Math.max(0, Math.round(full * (eligibleDays / daysInMonth)));
}

module.exports = { daysOnPayroll, prorateAllowance };
