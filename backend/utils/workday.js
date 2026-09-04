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
// Past this, a day's ONLY punch is a stray one rather than a short workday.
// Somebody who genuinely worked forty minutes started in the morning; somebody
// whose single punch pair is at 6 PM forgot to punch in and is punching at the
// end of the day, or tapped the button twice. Both are corrected by a
// regularization, not by charging them a day's pay — see belowDayMinimum.
// Set below WORKDAY_END_HOUR on purpose: the observed mis-punches ran from
// 5:50 PM to 9:25 PM, so an evening boundary at the close of business would
// have missed the earliest of them.
const EVENING_PUNCH_HOUR = 17;   // 5:00 PM IST

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

/* ---------------------------------------------------------------------------
 * Minimum hours for the day to count at all (SuperAdmin-set, default 1h).
 *
 * A day whose MEASURED time falls under this is not a short day, it is a
 * non-day: status 'Absent', which payroll counts as loss of pay. That is a real
 * deduction, so the rule is deliberately narrow — see `belowDayMinimum` for the
 * four cases it refuses to judge.
 *
 * Capped at HALF_DAY_MIN_HOURS because the bands have to stay in order: a floor
 * at or above the half-day line would swallow the half-day band entirely and
 * turn every short day straight into an absence. 0 switches the rule off.
 * ------------------------------------------------------------------------- */
const DEFAULT_MIN_PRESENT_HOURS = 1;

let minPresentHours = DEFAULT_MIN_PRESENT_HOURS;

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
 * Coerce a stored/posted minimum into a usable number of hours.
 * Clamped to [0, HALF_DAY_MIN_HOURS]; anything unparseable falls back to the
 * default rather than to NaN, so a bad value can never mark a whole company
 * absent (NaN comparisons are false, which would silently disable it instead —
 * either way, guessing beats propagating).
 * @param {number|string} v
 * @returns {number} hours, to 2dp
 */
function normalizeMinPresentHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MIN_PRESENT_HOURS;
  return +Math.min(HALF_DAY_MIN_HOURS, Math.max(0, n)).toFixed(2);
}

/**
 * Replace the cached day-minimum. Mirrors setLatePolicy — see
 * services/latePolicy.js for how the cache is kept in step with the Setting.
 * @param {number|string} v
 * @returns {number} the value now in force
 */
function setMinPresentHours(v) {
  minPresentHours = normalizeMinPresentHours(v);
  return minPresentHours;
}

/** @returns {number} the minimum hours a day must reach to count as worked. */
function getMinPresentHours() {
  return minPresentHours;
}

/**
 * Is this day's only punch an evening one?
 *
 * `date` is IST midnight, so the hour offset applies straight to it — the same
 * arithmetic halfDayCutoffPassed() uses, and it needs no timezone conversion.
 *
 * @param {{checkIn: Date, date: Date}} record
 * @returns {boolean}
 */
function eveningOnlyPunch(record) {
  if (!record || !record.checkIn) return false;
  const dur = Number(record.shiftDurationMin);
  if (record.shiftStart && Number.isFinite(dur) && dur > 0) {
    // The record knows its own window, so "a stray punch" can finally be stated
    // properly: one in the LAST QUARTER of this person's shift.
    //
    // The blanket 5 PM rule below exists only because, without a shift, an
    // evening punch was indistinguishable from a night-shift punch — so it had
    // to let every one of them through rather than mark a night worker absent
    // (see the EVENING_PUNCH_HOUR comment). That amnesty also meant a night
    // employee who punched in at 7:05 PM and out at 7:20 PM could never be
    // marked absent, while a day employee working the same fifteen minutes was.
    // With a window there is no need to guess, and the two are judged alike.
    const strayFrom = shiftStartAt(record).getTime() + dur * 0.75 * 60000;
    return new Date(record.checkIn).getTime() >= strayFrom;
  }
  const evening = new Date(record.date).getTime() + EVENING_PUNCH_HOUR * HOUR_MS;
  return new Date(record.checkIn).getTime() >= evening;
}

/**
 * Is this record short enough to be a non-day?
 *
 * Everything here is a REFUSAL to judge, and each one exists because judging
 * would take a day's pay off somebody who earned it:
 *
 *  - **No punch-out.** effectiveHours() then assumes the day ran to 7 PM, and an
 *    assumption must never cost a day. It also makes any check-in after 6 PM
 *    arithmetically "short" (after 7 PM it clamps to 0), so without this guard
 *    every evening and night-shift punch would be an absence.
 *  - **A declared half day.** Attendance.js states the hours rule must not undo
 *    the employee's own declaration, and this rule is the hours rule.
 *  - **A rest day.** A Sunday is already paid inside the monthly salary and a
 *    worked one pays double once approved; marking it absent would take the paid
 *    day away AND void the duty claim (restDayCredit returns 0 for 'Absent').
 *  - **A leave day being worked.** The leave day is handed back when the claim is
 *    approved, so an absence here would leave the employee worse off than if they
 *    had stayed at home.
 *  - **A day whose only punch is in the evening.** A real forty-minute day starts
 *    in the morning. A single pair at 6 PM is somebody who forgot to punch in and
 *    is punching at the end of the day, or who tapped twice — a stray punch, and
 *    the remedy for those is a regularization rather than a day's lost pay.
 *
 * @param {{checkIn: Date, checkOut: Date, date: Date, halfDayDeclared: boolean, workOnLeave: object}} record
 * @returns {boolean}
 */
function belowDayMinimum(record) {
  if (!minPresentHours) return false;                 // 0 = rule switched off
  if (!record || !record.checkIn || !record.checkOut) return false;
  if (record.halfDayDeclared) return false;
  if (record.workOnLeave) return false;
  // Same shape as halfDayCutoffPassed: `date` is IST midnight, so the hour
  // offset applies straight to it and no timezone conversion is needed.
  if (eveningOnlyPunch(record)) return false;
  // Sunday only: an org-wide comp-off day needs the Holiday collection, which
  // this synchronous path cannot reach. See the note in statusFromHours.
  const { ymdIST } = require('./dateHelpers');
  const { isSundayKey } = require('./restDay');
  if (isSundayKey(ymdIST(record.date))) return false;
  const hours = effectiveHours(record);
  return hours != null && hours < minPresentHours;
}

/* ---------------------------------------------------------------------------
 * Per-employee shift windows
 *
 * A record may carry a FROZEN copy of the shift it was worked under (see
 * models/Attendance.js). When it does, the two functions below answer "when was
 * this person due in?" and "when was their day due to end?" from that copy
 * instead of from the org-wide policy — which is what lets a 7 PM night shift
 * be judged as a 7 PM night shift.
 *
 * When it does not — every record written before shifts were honoured, and
 * every day worked by somebody with no shift — they reproduce the previous
 * expressions exactly. That is the whole safety argument for this change: it is
 * not "close enough", it is the same arithmetic, so no historic day can move.
 *
 * Both stay synchronous. The callers below are reached from payroll's month-long
 * filter and from two synchronous Excel-export builders; making them async would
 * push an `await` into the code path that decides pay.
 * ------------------------------------------------------------------------- */

/**
 * When this record's holder was due to start.
 * @param {{date: Date, shiftStart?: string}} record
 * @returns {Date}
 */
function shiftStartAt(record) {
  const base = new Date(record.date).getTime();
  const { parseHm } = require('./shiftWindow');
  const startMin = record && record.shiftStart ? parseHm(record.shiftStart) : null;
  if (startMin != null) return new Date(base + startMin * 60000);
  const { hour, minute } = latePolicy;
  return new Date(base + hour * HOUR_MS + minute * 60000);
}

/**
 * When this record's day was due to END. For a shift that crosses midnight this
 * is on the following calendar date — which is the point of storing the
 * duration rather than re-deriving it from two wall-clock strings.
 * @param {{date: Date, shiftStart?: string, shiftDurationMin?: number}} record
 * @returns {Date}
 */
function shiftEndAt(record) {
  const dur = Number(record && record.shiftDurationMin);
  if (record && record.shiftStart && Number.isFinite(dur) && dur > 0) {
    return new Date(shiftStartAt(record).getTime() + dur * 60000);
  }
  return new Date(new Date(record.date).getTime() + WORKDAY_END_HOUR * HOUR_MS);
}

/**
 * The instant a check-in stops being on time for this record.
 *
 * `date` is IST midnight (startOfDayIST), so the offsets apply directly. The
 * grace window is included: this is the moment lateness actually begins.
 *
 * Grace stays the LIVE org-wide setting rather than being frozen with the
 * shift. That is deliberate: freezing it would introduce a second retroactivity
 * rule, where a SuperAdmin's change to the grace window applied to unstamped
 * records but not to stamped ones. One value, one behaviour.
 *
 * @param {{date: Date, shiftStart?: string}} record - the attendance record
 * @returns {Date}
 */
function lateCutoff(record) {
  return new Date(shiftStartAt(record).getTime() + latePolicy.graceMinutes * 60000);
}

/**
 * The scheduled start of the workday (grace excluded) for this record.
 * "Late by" figures are measured from here — see lateMinutes().
 * @param {{date: Date, shiftStart?: string}} record - the attendance record
 * @returns {Date}
 */
function workdayStart(record) {
  return shiftStartAt(record);
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
  if (arrival <= lateCutoff(record).getTime()) return 0;
  // ...but once it is late, the figure counts from the scheduled start, so a
  // 10-minute window does not quietly shrink every late arrival by 10 minutes.
  const ms = arrival - workdayStart(record).getTime();
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
    : shiftEndAt(record).getTime();
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
  const dur = Number(record.shiftDurationMin);
  if (record.shiftStart && Number.isFinite(dur) && dur > 0) {
    // The midpoint of THEIR shift, not of the calendar day. Judging a night
    // shift against noon would put every single night check-in after the
    // cut-off, so every night worker would read as an "afternoon half day" —
    // and lateMinutes returns 0 for those, which would silently exempt night
    // staff from late marking altogether the moment one declared a half day.
    const mid = shiftStartAt(record).getTime() + (dur / 2) * 60000;
    return new Date(record.checkIn).getTime() > mid;
  }
  const cutoff = new Date(record.date).getTime() + HALF_DAY_CUTOFF_HOUR * HOUR_MS;
  return new Date(record.checkIn).getTime() > cutoff;
}

// Why this is NOT NON_WORKING_STATUSES: that set contains 'Absent', and a day
// already marked absent has to stay re-judgeable. Otherwise the day-minimum rule
// becomes a one-way door — the worker marks an unclosed evening absent, HR fills
// in the real 6 PM punch-out the next morning, and the record refuses to climb
// back to Present because it is now 'Absent'. Leave, holidays and weekly offs
// genuinely are untouchable: they say why somebody was away, and no arithmetic
// over punch times should overwrite that.
const HOURS_RULE_HOLDS = new Set(['OnLeave', 'Holiday', 'WeeklyOff']);

/**
 * The status a worked day should carry, given the hours it is worth.
 *
 * Three bands: under the SuperAdmin-set day minimum the day did not happen
 * ('Absent'); under HALF_DAY_MIN_HOURS it is a 'HalfDay'; otherwise 'Present'.
 * Leave, holidays and weekly offs are left alone so this can be called
 * unconditionally. See belowDayMinimum for the days the lowest band refuses to
 * judge — notably that it needs a real punch-out, never an assumed one.
 *
 * KNOWN GAP: an org-wide comp-off day worked briefly is not exempted here. The
 * Sunday test is arithmetic on the date, but comp-off days live in the Holiday
 * collection and this function is called synchronously from payroll and the
 * punch paths, so it cannot look them up. Rare, and HR can correct the day.
 *
 * @param {{status?: string, date: Date, checkIn?: Date, checkOut?: Date}} record
 * @returns {string|null} the status to apply, or null to leave the record alone
 */
function statusFromHours(record) {
  if (!record || !record.checkIn) return null;          // nothing punched — not ours to judge
  if (HOURS_RULE_HOLDS.has(record.status)) return null;
  // The 'Absent' un-latch is deliberately narrow: a day may climb back out of
  // Absent only when there is a REAL punch-out to re-judge it on. Without this,
  // the auto-close worker — whose records by definition have no punch-out —
  // would overturn an absence a human set, on nothing but the 7 PM assumption.
  if (record.status === 'Absent' && !record.checkOut) return null;
  const hours = effectiveHours(record);
  if (hours == null) return null;
  if (belowDayMinimum(record)) return 'Absent';
  return hours < HALF_DAY_MIN_HOURS ? 'HalfDay' : 'Present';
}

/**
 * The status to settle a day on, declaration included — the single place that
 * knows the precedence, so the five call sites cannot drift apart.
 *
 * `halfDayDeclared` outranks the hours rule (models/Attendance.js says so in as
 * many words). Three call sites — the auto-close worker, the HR record edit and
 * regularization approval — used to call statusFromHours directly with no
 * declaration guard, which was harmless while the worst it could return was
 * 'HalfDay' and is not harmless now that it can return 'Absent'.
 *
 * @param {object} record
 * @returns {string|null} the status to apply, or null to leave the record alone
 */
function settleStatus(record) {
  if (!record || !record.checkIn) return null;
  if (HOURS_RULE_HOLDS.has(record.status)) return null;
  // A day worked while on leave holds its LEAVE status until the claim is
  // decided — punching does not promote it to a worked day. This lived at the
  // punch-out call site only, which was fine while that was the one path that
  // settled a day; now that the worker and the HR edit come through here too, it
  // has to live where the precedence does. The approval path sets the status
  // explicitly once the claim is Approved, so it is unaffected.
  if (record.workOnLeave && record.workOnLeave.status !== 'Approved') return null;
  if (record.halfDayDeclared) return 'HalfDay';
  return statusFromHours(record);
}

module.exports = {
  WORKDAY_START_HOUR,
  shiftStartAt,
  shiftEndAt,
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
  settleStatus,
  belowDayMinimum,
  eveningOnlyPunch,
  EVENING_PUNCH_HOUR,
  DEFAULT_MIN_PRESENT_HOURS,
  normalizeMinPresentHours,
  setMinPresentHours,
  getMinPresentHours,
};
