/**
 * Which shift is this employee working, and which day does this punch belong to?
 *
 * This is the ASYNC half of the shift feature. It is reached only from the three
 * places that CREATE an attendance record — the two punch handlers and the
 * regularization/HR record paths — and its whole job is to decide what to freeze
 * onto that record. Everything downstream (utils/workday.js, payroll, the
 * exports) then reads the frozen copy and stays synchronous.
 *
 * Keeping the split this way round is deliberate. The judging functions are
 * called from payroll's month-long filter callback and from two synchronous
 * Excel builders; making them await a per-employee lookup would push database
 * round-trips into the code path that decides pay.
 *
 * ONE ID CROSSING, IN ONE PLACE. RosterEntry.employee refs User, while
 * Attendance.employee refs EmployeeProfile. The profile carries `user`, so the
 * crossing happens here and nowhere else — matching the wrong id silently
 * returns no roster row, which reads as "the shift feature does nothing".
 */
const RosterEntry = require('../models/RosterEntry');
const Shift = require('../models/Shift');
const Attendance = require('../models/Attendance');
const { startOfDayIST } = require('../utils/dateHelpers');
const { shiftSnapshot, windowFor, CARRY_GRACE_MS } = require('../utils/shiftWindow');
const { shiftEndAt } = require('../utils/workday');

/**
 * The shift an employee is on for one day: the roster overrides the standing
 * assignment, and no assignment at all means the org-wide hours.
 *
 * @param {{_id: any, user: any, shiftRef: any}} profile - an EmployeeProfile
 * @param {Date} dayIstMidnight
 * @returns {Promise<object|null>} a Shift document, or null
 */
async function resolveShiftForDay(profile, dayIstMidnight) {
  if (!profile) return null;
  const userId = profile.user?._id || profile.user;

  if (userId) {
    const entry = await RosterEntry.findOne({ employee: userId, date: startOfDayIST(dayIstMidnight) })
      .populate('shift')
      .lean();
    if (entry?.shift) return entry.shift;
  }

  const ref = profile.shiftRef?._id || profile.shiftRef;
  if (!ref) return null;
  // Already populated by the caller's query? Use it rather than re-fetching.
  if (profile.shiftRef?.startTime) return profile.shiftRef;
  return Shift.findById(ref).lean();
}

/**
 * Which attendance day a check-in at `now` belongs to, and the shift for it.
 *
 * The whole reason this is not just `startOfDayIST(now)` is the shift that runs
 * past midnight. Someone on 19:00–04:00 who arrives at 00:20 is arriving LATE
 * for yesterday's shift, not early for today's. Bucketing that punch under today
 * creates a second record, leaves yesterday's open for the auto-close worker to
 * settle from an assumption, and greets them with "Already checked in today"
 * when they turn up for their real shift nineteen hours later.
 *
 * The back-reach is gated on the previous day's shift actually crossing
 * midnight, which is false for the org default and for any daytime shift — so
 * for everyone not on a night shift this returns exactly what the old
 * `startOfDayIST(new Date())` returned.
 *
 * @param {object} profile - an EmployeeProfile (with `user`, ideally populated)
 * @param {Date} now
 * @returns {Promise<{day: Date, shift: object|null}>}
 */
async function resolveShiftDay(profile, now = new Date()) {
  const today = startOfDayIST(now);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  const prevShift = await resolveShiftForDay(profile, yesterday);
  const prevSnap = shiftSnapshot(prevShift);
  if (prevSnap?.shiftCrossesMidnight) {
    const win = windowFor(yesterday, prevSnap);
    const t = now.getTime();
    if (win && t >= win.startAt.getTime() && t <= win.endAt.getTime() + CARRY_GRACE_MS) {
      return { day: yesterday, shift: prevShift };
    }
  }

  return { day: today, shift: await resolveShiftForDay(profile, today) };
}

/**
 * A still-running overnight shift this employee has not closed yet.
 *
 * Used by check-out so that punching out at 04:05 closes last night's shift
 * instead of failing with "No check-in found for today" — which is exactly what
 * a 19:00–04:00 employee hits today, every single night.
 *
 * Filtered on `shiftCrossesMidnight`, which no record written before this
 * feature carries, so this can never claim a day-shift record.
 *
 * @param {any} profileId - EmployeeProfile id
 * @param {Date} now
 * @returns {Promise<object|null>} the open Attendance document, or null
 */
async function openShiftRecord(profileId, now = new Date()) {
  const today = startOfDayIST(now);
  const from = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);

  const open = await Attendance.findOne({
    employee: profileId,
    date: { $gte: from, $lt: today },
    checkIn: { $ne: null },
    checkOut: null,
    shiftCrossesMidnight: true,
  }).sort({ date: -1 });

  if (!open) return null;
  // Past the carry grace this is not a punch-out, it is a mis-punch. Leaving the
  // day open for the worker or a regularization is safer than folding hours the
  // employee did not work into a record payroll may already have read.
  if (now.getTime() > shiftEndAt(open).getTime() + CARRY_GRACE_MS) return null;
  return open;
}

// Every field shiftSnapshot() writes, so a day taken back to the org-wide hours
// is cleared of all of them rather than left half-stamped.
const SNAPSHOT_FIELDS = ['shift', 'shiftName', 'shiftStart', 'shiftEnd', 'shiftDurationMin', 'shiftCrossesMidnight'];

/**
 * Re-freeze one day's shift onto an attendance record that already exists,
 * after HR rostered (or un-rostered) that day.
 *
 * The punch freezes the shift the first time a day is punched, which is right
 * for a later edit to the Shift itself — but wrong for a roster row added for
 * that very day. HR roster someone onto Dispatch (11:00 AM) at 4 PM, after they
 * punched in at 10:32 under their usual 10:00 AM shift, and the day stays
 * judged at 10:00 AM: late, on a day they were told to come at 11. A roster row
 * is HR saying "this day runs on these hours", so the day follows it.
 *
 * Lateness is read from the snapshot at read time (utils/workday.lateMinutes),
 * so re-stamping is enough for every late figure. A day already punched out
 * also has its status re-settled, because the hours bands measure against the
 * shift too.
 *
 * Best-effort and silent when there is no record yet — the punch will freeze
 * the roster shift itself when it happens.
 *
 * @param {any} userId - RosterEntry.employee (a User id)
 * @param {Date} day - IST midnight of the rostered day
 * @param {{name?: string}} [actor] - who changed the roster, for the remark
 * @returns {Promise<object|null>} the updated Attendance document, or null
 */
async function restampDayShift(userId, day, actor) {
  const EmployeeProfile = require('../models/EmployeeProfile');
  const { settleStatus } = require('../utils/workday');
  const { to12h } = require('../utils/shiftWindow');

  const profile = await EmployeeProfile.findOne({ user: userId }).select('user shiftRef').lean();
  if (!profile) return null;
  const date = startOfDayIST(day);
  const record = await Attendance.findOne({ employee: profile._id, date });
  if (!record) return null;

  const snap = shiftSnapshot(await resolveShiftForDay(profile, date));
  const before = record.shift ? String(record.shift) : '';
  const beforeStart = record.shiftStart || '';
  if (before === String(snap?.shift || '') && beforeStart === (snap?.shiftStart || '')) return null;

  if (snap) {
    Object.assign(record, snap);
  } else {
    SNAPSHOT_FIELDS.forEach((f) => { record[f] = undefined; });
    record.shift = null;
    record.shiftCrossesMidnight = false;
  }

  if (record.checkIn && record.checkOut) {
    record.status = settleStatus(record) || record.status;
  }

  const label = snap
    ? `${snap.shiftName || 'shift'} (${to12h(snap.shiftStart)} – ${to12h(snap.shiftEnd)})`
    : 'the standard office hours';
  const line = `Roster changed this day to ${label}${actor?.name ? ` by ${actor.name}` : ''} — lateness re-judged against it.`;
  record.remarks = record.remarks ? `${record.remarks} ${line}` : line;

  await record.save();
  return record;
}

module.exports = { resolveShiftForDay, resolveShiftDay, openShiftRecord, restampDayShift };
