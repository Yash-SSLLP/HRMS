/**
 * Shift-window arithmetic, in one place.
 *
 * A Shift is two wall-clock strings — startTime '19:00', endTime '04:00' — and
 * every question worth asking about it ("how long is it?", "does it cross
 * midnight?", "when does the shift for Tuesday actually end?") is arithmetic on
 * those two. That arithmetic is needed by the punch handlers, the auto-close
 * worker, the synchronous judging in utils/workday.js and the admin UI, and
 * four copies of it would drift apart in exactly the way that produces a
 * night-shift employee who is marked absent on one screen and present on
 * another. It lives here instead.
 *
 * All times are IST. An attendance `date` is IST midnight (see
 * utils/dateHelpers.startOfDayIST), so a window is built by adding minutes to
 * that instant and nothing here needs a timezone conversion.
 */

// How long after a shift's scheduled end a punch still closes THAT shift rather
// than opening the next day's.
//
// The number has to be a compromise and it is worth saying which way it errs.
// Too short and a night worker who stays an extra hour finds their day never
// closed, which the auto-close worker then settles from an assumed end — the
// exact deduction this whole design exists to stop. Too long and a genuine
// next-morning mis-punch is swallowed into yesterday's record, inflating hours
// on a day payroll may already have looked at.
//
// Four hours covers realistic overtime on a nine-hour night shift while staying
// well clear of the next 19:00 start. Past it the day is deliberately left open
// for the worker or a regularization, because a punch six hours after the end
// of a shift is more likely a mistake than a close.
const CARRY_GRACE_MIN = 240;
const CARRY_GRACE_MS = CARRY_GRACE_MIN * 60 * 1000;

const MINUTES_PER_DAY = 24 * 60;

/**
 * Parse an 'HH:mm' wall-clock string into minutes since midnight.
 * @param {string} t
 * @returns {number|null} null when the string is missing or unparseable, which
 *   callers must treat as "this shift has no usable window" rather than as 0 —
 *   midnight is a legitimate start time and must not be confused with a blank.
 */
function parseHm(t) {
  if (typeof t !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * How many minutes a shift runs for.
 *
 * The modulo is what makes an overnight shift work: 19:00 → 04:00 is
 * (240 - 1140 + 1440) % 1440 = 540 minutes, not minus fifteen hours.
 *
 * A shift whose start equals its end is read as TWENTY-FOUR HOURS, not zero.
 * Zero would be the arithmetic answer and it is the wrong one: nobody defines a
 * shift of no length, and treating it as zero would give every such day an
 * assumed end identical to its start, which settles as a half day and charges
 * the employee for it.
 *
 * @param {string} startTime - 'HH:mm'
 * @param {string} endTime - 'HH:mm'
 * @returns {number|null} minutes, or null when either end is unusable
 */
function shiftDurationMin(startTime, endTime) {
  const s = parseHm(startTime);
  const e = parseHm(endTime);
  if (s == null || e == null) return null;
  const d = ((e - s) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return d === 0 ? MINUTES_PER_DAY : d;
}

/**
 * Does this shift run past midnight into the next calendar day?
 * @param {string} startTime - 'HH:mm'
 * @param {string} endTime - 'HH:mm'
 * @returns {boolean} false when either end is unusable — an unknown window is
 *   never treated as crossing, so the night-shift code paths stay unreachable
 *   for a half-configured shift.
 */
function crossesMidnight(startTime, endTime) {
  const s = parseHm(startTime);
  const d = shiftDurationMin(startTime, endTime);
  if (s == null || d == null) return false;
  return s + d > MINUTES_PER_DAY;
}

/**
 * Freeze a Shift into the fields stamped onto an Attendance record.
 *
 * The times are denormalized alongside the ref on purpose. shiftController's
 * deleteShift hard-deletes with no reference check, and an HR edit to the
 * "Night Shift" times must not re-price a September that has already been run —
 * the same reasoning that keeps checkInOutsideGeofence on the record rather
 * than recomputing it from the current office coordinates.
 *
 * @param {{_id: any, name?: string, startTime?: string, endTime?: string}} shift
 * @returns {object|null} the snapshot, or null when the shift has no usable
 *   window — a half-configured shift stamps nothing rather than a broken one,
 *   so the record falls back to the org-wide policy instead of to nonsense.
 */
function shiftSnapshot(shift) {
  if (!shift || !shift._id) return null;
  const durationMin = shiftDurationMin(shift.startTime, shift.endTime);
  if (durationMin == null) return null;
  return {
    shift: shift._id,
    shiftName: shift.name || '',
    shiftStart: shift.startTime,
    shiftEnd: shift.endTime,
    shiftDurationMin: durationMin,
    shiftCrossesMidnight: crossesMidnight(shift.startTime, shift.endTime),
  };
}

/**
 * The real instants a shift occupies for a given roster day.
 * @param {Date|number|string} dayIstMidnight - the attendance day
 * @param {{shiftStart: string, shiftDurationMin: number}} snap - a shiftSnapshot
 * @returns {{startAt: Date, endAt: Date}|null} null when the snapshot is unusable
 */
function windowFor(dayIstMidnight, snap) {
  if (!snap) return null;
  const startMin = parseHm(snap.shiftStart);
  const dur = Number(snap.shiftDurationMin);
  if (startMin == null || !Number.isFinite(dur) || dur <= 0) return null;
  const startAt = new Date(new Date(dayIstMidnight).getTime() + startMin * 60000);
  return { startAt, endAt: new Date(startAt.getTime() + dur * 60000) };
}

/**
 * Push a check-out that landed at or before its check-in forward by 24 hours.
 *
 * This is what lets HR type "04:00" as the punch-out of a night shift. Both
 * instants are built by the editors as `record.date + 'HH:mm'`, so a night
 * shift's real close reads as 4 AM on the morning the shift STARTED — earlier
 * than the 7 PM check-in, and rejected as an inverted pair. Rolling it forward
 * is the same correction regularization approval has always applied; it lives
 * here so both paths use one implementation.
 *
 * @param {Date} inAt
 * @param {Date} outAt
 * @returns {Date} outAt, moved forward a day if it did not follow inAt
 */
function rollForwardIfInverted(inAt, outAt) {
  if (!inAt || !outAt) return outAt;
  const i = new Date(inAt).getTime();
  const o = new Date(outAt).getTime();
  if (o > i) return outAt;
  return new Date(o + MINUTES_PER_DAY * 60000);
}

/** '19:00' → '7:00 PM'. Blank for an unusable time, never 'NaN:NaN'. */
function to12h(t) {
  const min = parseHm(t);
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

module.exports = {
  CARRY_GRACE_MIN,
  CARRY_GRACE_MS,
  MINUTES_PER_DAY,
  parseHm,
  shiftDurationMin,
  crossesMidnight,
  shiftSnapshot,
  windowFor,
  rollForwardIfInverted,
  to12h,
};
