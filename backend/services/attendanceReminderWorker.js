/**
 * Attendance reminders — two scheduled nudges a day, both pushed to mobile:
 *
 *   09:45 IST  "punch in"   → active employees who have not checked in yet and
 *                             are not off today (leave / holiday / Sunday).
 *   19:00 IST  "punch out"  → anyone who checked in today and has no check-out.
 *
 * Why the punch-out one matters: attendanceWorker stamps `noPunchOut` once the
 * day is over and settles the day from an ASSUMED close at WORKDAY_END_HOUR,
 * which can turn a real full day into a half day. That correction then costs the
 * employee a regularization and an approver's time — a push beforehand is far
 * cheaper than the paperwork afterwards. The two reminders share this file
 * because they share the schedule/claim machinery; only their audience differs.
 *
 * Each fires ONCE per day, guarded by a DigestLog row keyed (date, kind) exactly
 * like celebrationWorker, so a restart or an overlapping tick cannot double-send.
 * Neither repeats: a second punch-in nudge would fire at people already at their
 * desk, and a second punch-out nudge at people legitimately still working.
 *
 * Same lightweight interval pattern as the other workers — no node-cron anywhere
 * in this codebase.
 */
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const Holiday = require('../models/Holiday');
const { LeaveRequest } = require('../models/Leave');
const DigestLog = require('../models/DigestLog');
const Setting = require('../models/Setting');
const { notify } = require('./notify');
const { startOfDayIST } = require('../utils/dateHelpers');
const { istDateString, IST_TZ } = require('../utils/istDate');
const { WORKDAY_END_HOUR, NON_WORKING_STATUSES } = require('../utils/workday');

// Every 5 minutes, so a 09:45 reminder actually lands near 09:45 rather than up
// to a quarter of an hour late. The DigestLog claim makes extra ticks harmless.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const PUNCH_IN_AT = { h: 9, m: 45 };
const PUNCH_OUT_AT = { h: WORKDAY_END_HOUR, m: 0 };

// A reminder fires only INSIDE this many minutes after its scheduled time, not
// merely "at or after" it. Without the upper bound a server restart at 3 PM
// re-fires the 9:45 punch-in nudge at everyone who is absent that day — which is
// exactly what happened the first time this worker booted. Wide enough to
// survive a missed tick or a slow deploy, narrow enough that a late reminder is
// still recognisably about now. Missing the window skips that day, which is the
// right trade: a stale nudge is worse than no nudge.
const FIRE_WINDOW_MIN = 30;

let intervalHandle = null;
let ticking = false;

// Minutes since IST midnight — the server may not be in IST.
function istMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute');
}

// IST day of week, 0 = Sunday.
function istDayOfWeek(date = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

const hhmm = ({ h, m }) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;

// Claim today's run for `kind`; false when another tick already took it.
async function claim(kind, dateStr) {
  try {
    await DigestLog.create({ date: dateStr, kind });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // unique (date, kind) → already sent
    throw err;
  }
}

// Best-effort per recipient: one bad user must not abort the whole run.
async function pushEach(userIds, payload) {
  let sent = 0;
  for (const id of userIds) {
    try {
      await notify({ recipient: id, ...payload });
      sent += 1;
    } catch (err) {
      console.error('attendance reminder failed for a user:', err.message);
    }
  }
  return sent;
}

/**
 * 09:45 — nudge everyone who should be at work and has not checked in.
 *
 * Deliberately silent on a non-working day: without the Sunday/holiday guard
 * this would push at the whole company on a day off, which is the fastest way to
 * get people to mute the app's notifications entirely.
 * @returns {Promise<number>} reminders sent
 */
async function remindPunchIn(today) {
  // Sunday, or a listed holiday → nobody is expected in.
  if (istDayOfWeek() === 0) return 0;
  if (await Holiday.exists({ date: today })) return 0;

  const profiles = await EmployeeProfile.find({
    $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }],
  })
    .select('user')
    .populate({ path: 'user', select: 'isActive' })
    .lean();
  const active = profiles.filter((p) => p.user?._id && p.user.isActive !== false);
  if (!active.length) return 0;

  const ids = active.map((p) => p._id);

  // Already punched in, or the day is already marked as a non-working one for
  // them (the leave auto-stamp writes OnLeave/Absent onto the day at approval).
  const todays = await Attendance.find({ employee: { $in: ids }, date: today })
    .select('employee checkIn status').lean();
  const settled = new Set(
    todays
      .filter((a) => a.checkIn || NON_WORKING_STATUSES.has(a.status))
      .map((a) => String(a.employee))
  );

  // On approved leave covering today — belt and braces alongside the stamp
  // above, since a leave approved for a future date is stamped immediately but
  // an older record may predate that behaviour.
  const onLeave = await LeaveRequest.find({
    employee: { $in: ids },
    status: 'Approved',
    startDate: { $lte: today },
    endDate: { $gte: today },
  }).select('employee').lean();
  onLeave.forEach((l) => settled.add(String(l.employee)));

  const targets = active.filter((p) => !settled.has(String(p._id))).map((p) => p.user._id);
  if (!targets.length) return 0;

  return pushEach(targets, {
    type: 'attendance',
    audience: 'employee',
    title: 'Do not forget to punch in',
    body: 'You have not checked in yet today. Punch in from the Attendance screen so your day is recorded.',
    link: 'attendance',
  });
}

/**
 * 19:00 — nudge anyone still checked in with no check-out.
 * @returns {Promise<number>} reminders sent
 */
async function remindPunchOut(today) {
  const open = await Attendance.find({ date: today, checkIn: { $ne: null }, checkOut: null })
    .populate({ path: 'employee', select: 'user', populate: { path: 'user', select: 'isActive' } })
    .lean();

  const targets = open
    .map((r) => r.employee?.user)
    // A deactivated account cannot punch out and should not be pushed to.
    .filter((u) => u?._id && u.isActive !== false)
    .map((u) => u._id);
  if (!targets.length) return 0;

  return pushEach(targets, {
    type: 'attendance',
    audience: 'employee',
    title: 'Do not forget to punch out',
    body: "You checked in today but haven't checked out yet. Punch out before you leave so your hours are recorded correctly.",
    link: 'attendance',
  });
}

/**
 * The two reminders with their CURRENT schedule, read fresh from settings each
 * tick so a SuperAdmin's change takes effect on the next pass — no restart.
 * Falls back to the coded defaults if the settings read fails, because a
 * database hiccup must not silently stop the reminders altogether.
 * @returns {Promise<Array<{kind:string, at:{h:number,m:number}, enabled:boolean, run:Function}>>}
 */
async function schedule() {
  let cfg = {};
  try {
    const settings = await Setting.getSettings();
    cfg = settings?.attendanceReminders || {};
  } catch (err) {
    console.error('attendance reminder settings read failed, using defaults:', err.message);
  }
  const pick = (key, fallback) => {
    const c = cfg[key] || {};
    return {
      enabled: c.enabled !== false,
      h: Number.isInteger(c.hour) ? c.hour : fallback.h,
      m: Number.isInteger(c.minute) ? c.minute : fallback.m,
    };
  };
  const pin = pick('punchIn', PUNCH_IN_AT);
  const pout = pick('punchOut', PUNCH_OUT_AT);
  return [
    { kind: 'punchin-reminder', at: { h: pin.h, m: pin.m }, enabled: pin.enabled, run: remindPunchIn },
    { kind: 'punchout-reminder', at: { h: pout.h, m: pout.m }, enabled: pout.enabled, run: remindPunchOut },
  ];
}

/**
 * One pass: fire whichever reminders are due and not yet sent today.
 * @returns {Promise<number>} total reminders sent this tick
 * @sideEffects Writes DigestLog rows; creates Notifications and sends pushes.
 */
async function tick() {
  if (ticking) return 0;
  ticking = true;
  try {
    const now = new Date();
    const mins = istMinutes(now);
    const dateStr = istDateString(now);
    const today = startOfDayIST(now);

    let total = 0;
    for (const r of await schedule()) {
      if (!r.enabled) continue;                       // switched off by a SuperAdmin
      const due = r.at.h * 60 + r.at.m;
      if (mins < due || mins > due + FIRE_WINDOW_MIN) continue; // outside the firing window
      if (!(await claim(r.kind, dateStr))) continue;  // already sent today
      const sent = await r.run(today);
      total += sent;
      if (sent) {
        console.log(`${r.kind}: nudged ${sent} employee(s).`);
        await DigestLog.updateOne({ date: dateStr, kind: r.kind }, { $set: { count: sent } });
      }
    }
    return total;
  } catch (err) {
    console.error('attendanceReminderWorker tick failed:', err.message);
    return 0;
  } finally {
    ticking = false;
  }
}

/**
 * Start the reminder worker. Safe to call once at boot.
 * @returns {void}
 */
function startWorker() {
  if (intervalHandle) return;
  tick();
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  console.log('Attendance reminder worker started (times come from Settings; defaults '
    + `punch-in ${hhmm(PUNCH_IN_AT)}, punch-out ${hhmm(PUNCH_OUT_AT)} IST).`);
}

module.exports = { startWorker, tick, remindPunchIn, remindPunchOut };
