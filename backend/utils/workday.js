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
// Divides a half day into its morning and afternoon halves. A half day may be
// taken either way round; checking in after this means the AFTERNOON half, which
// does not start at WORKDAY_START_HOUR and so is never a late arrival — see
// halfDayCutoffPassed() and lateMinutes().
const HALF_DAY_CUTOFF_HOUR = 12; // 12:00 PM IST

const HOUR_MS = 60 * 60 * 1000;

// Statuses that describe why someone was away. The hours rule must never
// overwrite these — a day on approved leave is not a half day.
const NON_WORKING_STATUSES = new Set(['Absent', 'OnLeave', 'Holiday', 'WeeklyOff']);

/**
 * How many minutes past the 10:00 AM cut-off the employee checked in.
 *
 * Two kinds of day report 0 regardless of the clock:
 *
 *  - A day that isn't a worked day at all (NON_WORKING status) — you cannot be
 *    late for a day you were not working. Payroll's late count already filtered
 *    on Present/HalfDay, so this only brings the displayed "Late by" figures
 *    into line with the money that was already being charged.
 *  - An AFTERNOON half day: a declared half day whose check-in is after the
 *    12:00 PM cut-off. The second half does not begin at the 10:00 AM whistle,
 *    so arriving for it is not a late arrival. A declared half day starting
 *    BEFORE the cut-off is the morning half and is still judged against 10:00 AM.
 *
 * Sunday / comp-off duty is unaffected — those records are status 'Present', a
 * rest day being a property of the DATE, not the status.
 *
 * @param {{status?: string, halfDayDeclared?: boolean, date: Date, checkIn?: Date}} record
 * @returns {number} 0 when on time, not checked in, not a worked day, or an
 *                   afternoon half day
 */
function lateMinutes(record) {
  if (!record || !record.checkIn) return 0;
  if (NON_WORKING_STATUSES.has(record.status)) return 0;
  if (record.halfDayDeclared && halfDayCutoffPassed(record)) return 0;
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
 * Whether the check-in landed after the half-day cut-off (12:00 PM IST) — i.e.
 * whether a declared half day is the AFTERNOON (second) half rather than the
 * morning one.
 *
 * A half day may be taken either way round, so arriving after noon is a normal
 * way to work one and is never refused. What it changes is lateness: the second
 * half doesn't begin at the 10:00 AM whistle, so such a day is not a late
 * arrival — see lateMinutes(). Returns false when there is no check-in to judge.
 *
 * `date` is IST midnight (startOfDayIST), so the hour offset applies directly —
 * the same arithmetic lateMinutes() uses.
 *
 * @param {{date: Date, checkIn?: Date}} record
 * @returns {boolean}
 */
function halfDayCutoffPassed(record) {
  if (!record || !record.checkIn) return false;
  const cutoff = new Date(record.date).getTime() + HALF_DAY_CUTOFF_HOUR * HOUR_MS;
  return new Date(record.checkIn).getTime() > cutoff;
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
  HALF_DAY_CUTOFF_HOUR,
  NON_WORKING_STATUSES,
  lateMinutes,
  effectiveHours,
  halfDayCutoffPassed,
  statusFromHours,
};
