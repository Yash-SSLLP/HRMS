/**
 * The company's working-day rules, in one place.
 *
 * `WORKDAY_START_HOUR` used to be copy-pasted across attendanceController,
 * payrollController and managerController, and the lateness arithmetic was
 * repeated five times in attendanceController alone. Everything that needs to
 * know when a day starts, when it is assumed to end, or whether a day counts as
 * a half day should import from here so the three modules cannot drift.
 *
 * All times are IST. Attendance `date` is stored as IST midnight, so the hour
 * offsets below are applied straight to it.
 */

const WORKDAY_START_HOUR = 10;   // check-in after 10:00 AM IST counts as late
const WORKDAY_END_HOUR = 19;     // 7:00 PM IST — assumed close for a missing punch-out
const HALF_DAY_MIN_HOURS = 6;    // a day under this is a half day until regularized

const HOUR_MS = 60 * 60 * 1000;

// Statuses that describe why someone was away. The hours rule must never
// overwrite these — a day on approved leave is not a half day.
const NON_WORKING_STATUSES = new Set(['Absent', 'OnLeave', 'Holiday', 'WeeklyOff']);

/**
 * How many minutes past the 10:00 AM cut-off the employee checked in.
 * @param {{date: Date, checkIn?: Date}} record
 * @returns {number} 0 when on time or not checked in
 */
function lateMinutes(record) {
  if (!record || !record.checkIn) return 0;
  const cutoff = new Date(record.date).getTime() + WORKDAY_START_HOUR * HOUR_MS;
  const ms = new Date(record.checkIn).getTime() - cutoff;
  return ms > 0 ? Math.round(ms / 60000) : 0;
}

/**
 * Hours the day is worth for the half-day test.
 *
 * With both punches this is the real elapsed time. With a check-in but no
 * check-out the day is counted to 7:00 PM — the employee was present from their
 * punch-in, and a forgotten punch-out should not be free, but neither should it
 * cost the whole day. Regularizing the day replaces this with the real times.
 *
 * @param {{date: Date, checkIn?: Date, checkOut?: Date, hoursWorked?: number}} record
 * @returns {number|null} hours, or null when there is no check-in to measure from
 */
function effectiveHours(record) {
  if (!record || !record.checkIn) return null;
  const inMs = new Date(record.checkIn).getTime();
  const outMs = record.checkOut
    ? new Date(record.checkOut).getTime()
    : new Date(record.date).getTime() + WORKDAY_END_HOUR * HOUR_MS;
  const hours = (outMs - inMs) / HOUR_MS;
  return hours > 0 ? +hours.toFixed(2) : 0;
}

/**
 * The status a worked day should carry, given the hours it is worth.
 *
 * Only ever returns 'Present' or 'HalfDay' — and only for days that are already
 * a worked day. Leave, holidays, weekly offs and absences are returned
 * unchanged so this can be called unconditionally.
 *
 * @param {{status?: string, date: Date, checkIn?: Date, checkOut?: Date}} record
 * @returns {string|null} the status to apply, or null to leave the record alone
 */
function statusFromHours(record) {
  if (!record || !record.checkIn) return null;          // nothing punched — not ours to judge
  if (NON_WORKING_STATUSES.has(record.status)) return null;
  const hours = effectiveHours(record);
  if (hours == null) return null;
  return hours < HALF_DAY_MIN_HOURS ? 'HalfDay' : 'Present';
}

module.exports = {
  WORKDAY_START_HOUR,
  WORKDAY_END_HOUR,
  HALF_DAY_MIN_HOURS,
  NON_WORKING_STATUSES,
  lateMinutes,
  effectiveHours,
  statusFromHours,
};
