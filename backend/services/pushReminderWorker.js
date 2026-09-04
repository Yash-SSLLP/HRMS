/**
 * Scheduled push reminders. Two are built in, and a SuperAdmin can add any
 * number of their own on top.
 *
 * BUILT-IN (times configurable in Settings, audience is not):
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
 * CUSTOM (models/PushReminder): a SuperAdmin's own title/message/time, sent to
 * everyone or to one department, on chosen weekdays. They ride exactly the same
 * firing window and once-per-day claim as the built-ins, so they inherit the
 * restart-safety rather than reimplementing it. The built-ins stay in Settings
 * because their audiences are computed (who has not punched in, who is still
 * checked in) and no generic row could express that.
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
const PushReminder = require('../models/PushReminder');
const { notify } = require('./notify');
const { startOfDayIST } = require('../utils/dateHelpers');
const { istDateString, IST_TZ } = require('../utils/istDate');
const { WORKDAY_END_HOUR, NON_WORKING_STATUSES } = require('../utils/workday');
const Shift = require('../models/Shift');
const { parseHm, crossesMidnight, to12h } = require('../utils/shiftWindow');

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
async function remindPunchIn(today, shiftId = null) {
  // Sunday, or a listed holiday → nobody is expected in.
  if (istDayOfWeek() === 0) return 0;
  if (await Holiday.exists({ date: today })) return 0;

  // Split by shift so nobody is nudged twice. A shift-timed run takes only that
  // shift's people; the org-wide run takes only those with NO shift, rather than
  // everyone — otherwise a night worker would get the 09:45 nudge as well as
  // their own, which is the noise that teaches people to mute the app.
  const profiles = await EmployeeProfile.find({
    $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }],
    ...(shiftId ? { shiftRef: shiftId } : { shiftRef: null }),
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
async function remindPunchOut(today, shiftId = null) {
  // Keyed off the record's own frozen shift rather than the employee's current
  // one: if somebody was moved between shifts today, the day being closed
  // belongs to the shift they actually worked.
  const open = await Attendance.find({
    date: today,
    checkIn: { $ne: null },
    checkOut: null,
    ...(shiftId ? { shift: shiftId } : { shift: null }),
  })
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
 * Recipients for a custom reminder: every active employee, or one department.
 * @param {Object} rem - a PushReminder
 * @returns {Promise<Array>} User ids
 */
async function customAudience(rem) {
  const filter = { $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }] };
  if (rem.audience === 'department') {
    // An empty department would silently mean "everyone", which is the opposite
    // of what the author asked for — so it targets nobody instead.
    if (!rem.department) return [];
    filter.department = rem.department;
  }
  const profiles = await EmployeeProfile.find(filter)
    .select('user')
    .populate({ path: 'user', select: 'isActive' })
    .lean();
  return profiles
    .filter((p) => p.user?._id && p.user.isActive !== false)
    .map((p) => p.user._id);
}

/**
 * Load the SuperAdmin-authored reminders that are due today, shaped like the
 * built-ins so tick() can treat them identically.
 * @param {number} dow - IST day of week, 0 = Sunday
 */
async function customReminders(dow) {
  let rows = [];
  try {
    rows = await PushReminder.find({ enabled: true }).lean();
  } catch (err) {
    console.error('custom reminder load failed:', err.message);
    return [];
  }
  return rows
    // An empty `days` means every day; otherwise today must be listed.
    .filter((r) => !r.days?.length || r.days.includes(dow))
    .map((r) => ({
      // Keyed by id, so renaming or re-timing a reminder cannot collide with
      // another one's claim for the same day.
      kind: `custom:${r._id}`,
      at: { h: r.hour, m: r.minute },
      enabled: true,
      run: async () => {
        const targets = await customAudience(r);
        if (!targets.length) return 0;
        const sent = await pushEach(targets, {
          type: 'general',
          audience: 'employee',
          title: r.title,
          body: r.body || undefined,
        });
        if (sent) {
          await PushReminder.updateOne(
            { _id: r._id },
            { $set: { lastSentAt: new Date(), lastSentCount: sent } }
          ).catch(() => {});
        }
        return sent;
      },
    }));
}

// How long before a shift starts its people are nudged to punch in. Matches the
// 15 minutes the org-wide default leaves between 09:45 and a 10:00 start, so a
// shift-timed nudge feels like the same reminder, not a new one.
const PUNCH_IN_LEAD_MIN = 15;

/**
 * Punch reminders timed to each SHIFT rather than to one org-wide clock.
 *
 * Without this a night-shift employee gets "don't forget to punch in" at 09:45,
 * eleven hours before their shift starts, and "don't forget to punch out" at
 * 19:00, ten minutes after they arrived. Both are noise, and noise is what
 * teaches people to mute the app.
 *
 * Each shift gets its own DigestLog claim key (`punchin-reminder:<shiftId>`) so
 * the once-per-day guard is per shift, not shared — otherwise the first shift to
 * fire would claim the day and silence every other one.
 *
 * Employees with no shift are untouched here; they stay with the built-in
 * org-wide reminders above.
 *
 * @param {{leadMin: number, enabled: boolean}} inCfg
 * @param {{enabled: boolean}} outCfg
 * @returns {Promise<Array>} schedule entries shaped like the built-ins
 */
async function shiftSchedule(inCfg, outCfg) {
  let shifts = [];
  try {
    shifts = await Shift.find({ isActive: true }).select('name startTime endTime').lean();
  } catch (err) {
    console.error('shift reminder load failed:', err.message);
    return [];
  }

  const out = [];
  for (const s of shifts) {
    const startMin = parseHm(s.startTime);
    const endMin = parseHm(s.endTime);
    if (startMin == null || endMin == null) continue; // half-configured shift

    const inAt = (startMin - inCfg.leadMin + 1440) % 1440;
    out.push({
      kind: `punchin-reminder:${s._id}`,
      at: { h: Math.floor(inAt / 60), m: inAt % 60 },
      enabled: inCfg.enabled,
      run: (today) => remindPunchIn(today, s._id),
    });

    // The punch-out nudge for an overnight shift fires on the calendar day AFTER
    // the one the record is dated. A 04:00 close is reminded at 04:00 on the 6th
    // about a shift dated the 5th — so this run is handed yesterday, or it would
    // look for open records on a day that has barely started and find none.
    const overnight = crossesMidnight(s.startTime, s.endTime);
    out.push({
      kind: `punchout-reminder:${s._id}`,
      at: { h: Math.floor(endMin / 60), m: endMin % 60 },
      enabled: outCfg.enabled,
      run: (today) => remindPunchOut(
        overnight ? new Date(today.getTime() - 24 * 60 * 60 * 1000) : today,
        s._id,
      ),
    });
  }
  return out;
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
    ...(await shiftSchedule({ leadMin: PUNCH_IN_LEAD_MIN, enabled: pin.enabled }, { enabled: pout.enabled })),
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

    // Built-ins plus whichever custom reminders are scheduled for today. Both
    // kinds are the same shape from here on, so the window/claim logic below is
    // written once.
    const due = [...(await schedule()), ...(await customReminders(istDayOfWeek(now)))];

    let total = 0;
    for (const r of due) {
      if (!r.enabled) continue;                       // switched off by a SuperAdmin
      const dueAt = r.at.h * 60 + r.at.m;
      if (mins < dueAt || mins > dueAt + FIRE_WINDOW_MIN) continue; // outside the firing window
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
