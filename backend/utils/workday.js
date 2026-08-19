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

const WORKDAY_START_HOUR = 10;   // default start: check-in after 10:00 AM IST is late
const WORKDAY_END_HOUR = 19;     // 7:00 PM IST — assumed close for a missing punch-out
const HALF_DAY_MIN_HOURS = 6;    // a day under this is a half day until regularized
// Divides a half day into its morning and afternoon halves. A half day may be
// taken either way round; checking in after this means the AFTERNOON half, which
// does not start at WORKDAY_START_HOUR and so is never a late arrival — see
// halfDayCutoffPassed() and lateMinutes().
const HALF_DAY_CUTOFF_HOUR = 12; // 12:00 PM IST

const HOUR_MS = 60 * 60 * 1000;

/* ---------------------------------------------------------------------------
 * Late-marking policy (runtime configurable)
 *
 * When lateness starts biting used to be the WORKDAY_START_HOUR constant, so
 * moving it meant a deploy. A SuperAdmin now sets it from Admin → Attendance →
 * Office & Geofence, and it is stored on the Setting singleton.
 *
 * lateMinutes() is called from list/report/payroll code paths that are already
 * synchronous, so the policy lives in a module-level cache rather than being
 * awaited per record: services/latePolicy.js loads it after the DB connects and
 * re-reads it periodically, and the settings endpoint pushes changes in
 * immediately. Until something sets it, the defaults below reproduce the old
 * hard-coded behaviour exactly — 10:00 AM, no grace.
 *
 * `graceMinutes` is a forgiveness window, not a new start time: arriving inside
 * it is not late at all, and arriving past it is late measured from the start
 * time itself (10:12 with a 10-minute window is "late by 12m", not 2m) so the
 * figure always answers "how late were they?".
 * ------------------------------------------------------------------------- */

const DEFAULT_LATE_POLICY = { hour: WORKDAY_START_HOUR, minute: 0, graceMinutes: 0 };
const MAX_GRACE_MINUTES = 240;   // 4h — a window wider than this is a data-entry slip

let latePolicy = { ...DEFAULT_LATE_POLICY };

// Coerce whatever came out of the database / an HTTP body into a usable policy.
// Anything missing or out of range falls back to the default field rather than
// to NaN, so a bad value can never make every arrival late (or none of them).
function normalizeLatePolicy(p) {
  const num = (v, fallback, min, max) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    hour: num(p && p.hour, DEFAULT_LATE_POLICY.hour, 0, 23),
    minute: num(p && p.minute, DEFAULT_LATE_POLICY.minute, 0, 59),
    graceMinutes: num(p && p.graceMinutes, DEFAULT_LATE_POLICY.graceMinutes, 0, MAX_GRACE_MINUTES),
  };
}

/**
 * Replace the cached late-marking policy for this process.
 * @param {{hour?: number, minute?: number, graceMinutes?: number}} p
 * @returns {{hour: number, minute: number, graceMinutes: number}} the policy now in force
 */
function setLatePolicy(p) {
  latePolicy = normalizeLatePolicy(p);
  return { ...latePolicy };
}

/**
 * The late-marking policy currently in force (a copy — mutate it freely).
 * @returns {{hour: number, minute: number, graceMinutes: number}}
 */
function getLatePolicy() {
  return { ...latePolicy };
}

/**
 * The instant a check-in stops being on time, for a given attendance date.
 *
 * `date` is IST midnight (startOfDayIST), so the offsets apply directly. The
 * grace window is included: this is the moment lateness actually begins.
 *
 * @param {Date|number|string} date - the attendance day (IST midnight)
 * @returns {Date}
 */
function lateCutoff(date) {
  const base = new Date(date).getTime();
  const { hour, minute, graceMinutes } = latePolicy;
  return new Date(base + hour * HOUR_MS + (minute + graceMinutes) * 60000);
}

/**
 * The scheduled start of the workday (grace excluded) for a given date.
 * "Late by" figures are measured from here — see lateMinutes().
 * @param {Date|number|string} date - the attendance day (IST midnight)
 * @returns {Date}
 */
function workdayStart(date) {
  const { hour, minute } = latePolicy;
  return new Date(new Date(date).getTime() + hour * HOUR_MS + minute * 60000);
}

// Statuses that describe why someone was away. The hours rule must never
// overwrite these — a day on approved leave is not a half day.
const NON_WORKING_STATUSES = new Set(['Absent', 'OnLeave', 'Holiday', 'WeeklyOff']);

/**
 * How many minutes past the configured start of the workday the employee
 * checked in — 0 while they are inside the grace window (see getLatePolicy).
 *
 * Two kinds of day report 0 regardless of the clock:
 *
 *  - A day that isn't a worked day at all (NON_WORKING status) — you cannot be
 *    late for a day you were not working. Payroll's late count already filtered
 *    on Present/HalfDay, so this only brings the displayed "Late by" figures
 *    into line with the money that was already being charged.
 *  - An AFTERNOON half day: a declared half day whose check-in is after the
 *    12:00 PM cut-off. The second half does not begin at the morning whistle,
 *    so arriving for it is not a late arrival. A declared half day starting
 *    BEFORE the cut-off is the morning half and is still judged against it.
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
  const arrival = new Date(record.checkIn).getTime();
  // Inside the grace window is not late at all...
  if (arrival <= lateCutoff(record.date).getTime()) return 0;
  // ...but once it is late, the figure counts from the scheduled start, so a
  // 10-minute window does not quietly shrink every late arrival by 10 minutes.
  const ms = arrival - workdayStart(record.date).getTime();
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
  DEFAULT_LATE_POLICY,
  MAX_GRACE_MINUTES,
  normalizeLatePolicy,
  setLatePolicy,
  getLatePolicy,
  lateCutoff,
  workdayStart,
  WORKDAY_END_HOUR,
  HALF_DAY_MIN_HOURS,
  HALF_DAY_CUTOFF_HOUR,
  NON_WORKING_STATUSES,
  lateMinutes,
  effectiveHours,
  halfDayCutoffPassed,
  statusFromHours,
};
