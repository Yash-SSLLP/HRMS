/**
 * Minting the occurrences of a repeating task.
 *
 * REWRITTEN 2026-09-21. "90% of the tasks you give are repetitive" — the daily
 * invoice, Friday's report, the monthly stock count. A RecurringTask is the
 * schedule; this turns it into ordinary Tasks, one per occurrence, which are
 * then worked, scored and reported exactly like a one-off. Nothing else in the
 * module knows recurrence exists — bar one flag: a DAILY occurrence is ROUTINE
 * (see below).
 *
 * THE OCCURRENCE KEY IS THE WHOLE SAFETY MECHANISM. Every minted task carries
 * `occurrenceKey` — the IST day it is FOR — under a UNIQUE compound index with
 * `recurringTask` (models/Task). A worker that restarts, two server instances,
 * a catch-up over a week the machine was down: all of them try to insert a key
 * that already exists and get a duplicate-key error instead of a second copy of
 * Monday's task. Idempotence by database constraint rather than by remembering
 * to check — the only kind that survives a redeploy at the wrong moment.
 *
 * IT CATCHES UP, BUT NOT FOREVER. A schedule that has not run for a month mints
 * the occurrences it missed, capped at CATCHUP_DAYS. Uncapped, restoring a
 * backup from last quarter would hand somebody ninety tasks in one push — which
 * is very close to the trap this module's first version fell into, when a
 * backlog sweep fired 51 overdue notifications on day one.
 *
 * ── REWORKED 2026-09-27 (the Recurring tab) ─────────────────────────────────
 *
 * ALL DATE MATHS IS IN IST, BY DAY KEY. The first version asked the SERVER's
 * clock — `d.setHours(18)` — and the server runs in UTC, so a task set "daily
 * at 6 pm" fell due at 11:30 pm portal time. Days are now 'YYYY-MM-DD' keys
 * read in Asia/Kolkata, stepped in pure UTC arithmetic, and a due time is built
 * as `${key}T18:00:00+05:30`. No server zone reaches any of it.
 *
 * NEW SHAPES (config/tasks): every N days, the Nth weekday of the month.
 *
 * AN OCCURRENCE APPEARS BEFORE IT IS DUE — at 9 am on its day (or an hour
 * before, for an early one), and for a monthly task two days early: the user's
 * *"for monthly task 2 day before the deadline"*. `leadDays` on the schedule.
 *
 * NOTHING IS BORN OVERDUE. `mintFrom` — set when a schedule is created or
 * switched back on — skips any occurrence due before it, so a daily 6 pm task
 * set up at 7 pm starts tomorrow, and a fortnight's pause is not handed over in
 * one go when it resumes.
 *
 * A DAILY OCCURRENCE IS ROUTINE: minted already taken on, with no review, so the
 * one thing its doer is offered is Done (*"for daily task they have to only
 * mark that as done"*).
 */
const RecurringTask = require('../models/RecurringTask');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const notify = require('./taskNotify');
const {
  FREQUENCY, STATUS, ACCEPTANCE, MONTHLY_MODE, DEFAULT_LEAD_DAYS, MAX_LEAD_DAYS,
  APPEAR_HOUR, isRoutineFrequency, MAX_DAY_INTERVAL,
} = require('../config/tasks');
const { departedUserIdSet } = require('../utils/departed');

/** How far back a sleeping schedule may catch up. See the docblock. */
const CATCHUP_DAYS = 7;
/** How often the sweep runs. An occurrence appears within this of 9 am. */
const TICK_MS = 5 * 60 * 1000;
/** How far ahead the next occurrence is looked for — a year and a bit. */
const LOOKAHEAD_DAYS = 400;

const IST = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit',
});

const pad = (n) => String(n).padStart(2, '0');

/** "2026-09-21" for an instant, in IST — the occurrence key's format. */
function occurrenceKeyFor(date) {
  return KEY_FMT.format(new Date(date));
}

/** A day key as a UTC midnight, for arithmetic that no zone can shift. */
function keyToUtc(key) {
  const [y, m, d] = String(key).split('-').map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

function utcToKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const addDaysKey = (key, n) => utcToKey(keyToUtc(key) + n * DAY_MS);
const daysBetween = (a, b) => Math.round((keyToUtc(b) - keyToUtc(a)) / DAY_MS);

/** Year, month (1-12), day, weekday (0 = Sunday) and the month's last day. */
function partsOf(key) {
  const ms = keyToUtc(key);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return {
    y, m, d: d.getUTCDate(), dow: d.getUTCDay(), last: new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}

/** "HH:mm" → [h, m], defaulting to 6 pm like every schedule before it. */
function hm(hhmm) {
  const [h, m] = String(hhmm || '18:00').split(':').map((n) => parseInt(n, 10));
  return [Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 18, Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0];
}

/** The instant a day key reads `hhmm` in IST. */
function atIST(key, hhmm = '18:00') {
  const [h, m] = hm(hhmm);
  return new Date(`${key}T${pad(h)}:${pad(m)}:00+05:30`);
}

/**
 * Kept for anything that still calls it with a Date: that day (read in IST)
 * at `hhmm` IST. The old version set hours on the SERVER's clock — see the
 * docblock — which is the bug this file was reworked for.
 */
function atTime(date, hhmm = '18:00') {
  return atIST(occurrenceKeyFor(date), hhmm);
}

/** Whole days before the due date an occurrence appears, clamped. */
function leadDaysOf(schedule) {
  const n = Number(schedule?.leadDays);
  if (Number.isFinite(n) && n >= 0) return Math.min(MAX_LEAD_DAYS, Math.round(n));
  return DEFAULT_LEAD_DAYS[schedule?.frequency] ?? 0;
}

const intervalOf = (schedule) => {
  const n = Math.round(Number(schedule?.interval) || 1);
  return Math.min(MAX_DAY_INTERVAL, Math.max(1, n));
};

/** Does this schedule fall due on this IST day (a 'YYYY-MM-DD' key)? */
function fallsOn(schedule, dayKey) {
  // Accept a Date as well — an older caller hands one in.
  const key = typeof dayKey === 'string' ? dayKey : occurrenceKeyFor(dayKey);
  // Nothing before the start. (A schedule with no start date at all is only
  // ever a caller's sketch — it is judged on the pattern alone.)
  const startKey = schedule.startDate ? occurrenceKeyFor(schedule.startDate) : null;
  if (startKey && key < startKey) return false;
  const anchorKey = startKey || key;
  const p = partsOf(key);

  switch (schedule.frequency) {
    case FREQUENCY.DAILY:
      // Every N days counted FROM THE START DATE, so "alternate days" is the
      // same set of days for everybody on it and does not drift with restarts.
      return daysBetween(anchorKey, key) % intervalOf(schedule) === 0;

    case FREQUENCY.WEEKLY: {
      const days = schedule.weekdays?.length ? schedule.weekdays.map(Number) : [partsOf(anchorKey).dow];
      return days.includes(p.dow);
    }

    case FREQUENCY.MONTHLY: {
      const wd = Number(schedule.weekday);
      if (schedule.monthlyMode === MONTHLY_MODE.WEEKDAY && Number.isInteger(wd) && wd >= 0 && wd <= 6) {
        if (p.dow !== wd) return false;
        const nth = Number(schedule.nthWeek) || 1;
        // The last one is the one with no same weekday a week later in the month.
        return nth === -1 ? p.d + 7 > p.last : Math.ceil(p.d / 7) === nth;
      }
      const want = Number(schedule.monthDay) || partsOf(anchorKey).d;
      // 29–31 clamp to the last day of a short month, so a "31st" schedule
      // still fires in February rather than silently skipping it.
      return p.d === Math.min(want, p.last);
    }

    case FREQUENCY.YEARLY: {
      const sp = partsOf(anchorKey);
      const wantM = Number(schedule.month) || sp.m;
      const wantD = Number(schedule.monthDay) || sp.d;
      const lastOfWanted = new Date(Date.UTC(p.y, wantM, 0)).getUTCDate();
      return p.m === wantM && p.d === Math.min(wantD, lastOfWanted);
    }

    default:
      return false;
  }
}

/**
 * When the occurrence due on `key` shows up in the doer's list.
 *
 * 9 am on its day — or `leadDays` earlier for a monthly/yearly task. A task due
 * before ten with no lead appears an hour before it is due instead, so a 9:30
 * opening check is not handed over at the moment it is already late.
 */
function appearAt(schedule, key) {
  const due = atIST(key, schedule.time);
  const lead = leadDaysOf(schedule);
  const morning = atIST(addDaysKey(key, -lead), `${APPEAR_HOUR}:00`);
  const hourBefore = new Date(due.getTime() - 60 * 60 * 1000);
  return lead === 0 && hourBefore < morning ? hourBefore : morning;
}

/**
 * The next occurrence at or after `from` — its key, when it is due and when it
 * will appear. Null for a schedule that has nothing left (past its end date).
 */
function nextOccurrence(schedule, from = new Date(), { skipKeys = null } = {}) {
  const startKey = occurrenceKeyFor(schedule.startDate || from);
  const fromKey = occurrenceKeyFor(from);
  let key = startKey > fromKey ? startKey : fromKey;
  const untilKey = schedule.until ? occurrenceKeyFor(schedule.until) : null;
  const floor = schedule.mintFrom ? new Date(schedule.mintFrom) : null;
  for (let i = 0; i < LOOKAHEAD_DAYS; i += 1, key = addDaysKey(key, 1)) {
    if (untilKey && key > untilKey) return null;
    if (!fallsOn(schedule, key)) continue;
    // Already raised (the schedule card's "next" is the next one STILL TO COME).
    if (skipKeys && skipKeys.has(key)) continue;
    const dueAt = atIST(key, schedule.time);
    if (dueAt < from) continue;
    if (floor && dueAt < floor) continue;
    return { key, dueAt, appearAt: appearAt(schedule, key) };
  }
  return null;
}

/**
 * The deadline of the FIRST occurrence of a schedule.
 *
 * Used by the old assign form's Repeat box (taskController.createTask), which
 * makes the first occurrence itself so a freshly repeating task has a date on
 * it at once.
 */
function firstDueDate(schedule) {
  const startKey = occurrenceKeyFor(schedule.startDate || Date.now());
  let key = startKey;
  for (let i = 0; i < LOOKAHEAD_DAYS; i += 1, key = addDaysKey(key, 1)) {
    if (fallsOn(schedule, key)) return atIST(key, schedule.time);
  }
  return atIST(startKey, schedule.time);
}

const personName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();

/**
 * Names and employee codes onto the rows — the same snapshot the assign form
 * takes (taskController.buildAssignees). The first version minted bare
 * `{ user }` rows, so a recurring task read "To —" on every list.
 */
async function snapshotPeople(ids) {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) return new Map();
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: list } }).select('firstName lastName').lean(),
    EmployeeProfile.find({ user: { $in: list } }).select('user employeeCode').lean(),
  ]);
  const codeOf = new Map(profiles.map((p) => [String(p.user), p.employeeCode || '']));
  return new Map(users.map((u) => [String(u._id), { name: personName(u), employeeCode: codeOf.get(String(u._id)) || '' }]));
}

/**
 * Build one occurrence from a schedule. Returns null if it already exists — or
 * if everybody it is for has left.
 *
 * A schedule outlives the people on it: set in March for somebody who resigned
 * in August, it went on raising their Friday report every week, and each new
 * task put a leaver's name back on the board. Nobody who has left is given new
 * work (utils/departed), so they are dropped from each occurrence as it is made;
 * the schedule itself is left alone, so the person who set it can re-point it.
 */
async function mintOccurrence(schedule, dueDate, { key, appear, now = new Date() } = {}) {
  const occurrenceKey = key || occurrenceKeyFor(dueDate);
  const gone = await departedUserIdSet([...(schedule.assignees || []), ...(schedule.loopUsers || [])]);
  const assignees = (schedule.assignees || []).filter((u) => !gone.has(String(u)));
  if (!assignees.length) return null;
  const loopUsers = (schedule.loopUsers || []).filter((u) => !gone.has(String(u)));
  const routine = isRoutineFrequency(schedule.frequency);
  const people = await snapshotPeople(assignees);
  const appeared = appear || now;

  try {
    const task = await Task.create({
      title: schedule.title,
      description: schedule.description,
      category: schedule.category,
      company: schedule.company,
      createdBy: schedule.createdBy,
      createdByName: schedule.createdByName,
      assignees: assignees.map((u) => ({
        user: u,
        name: people.get(String(u))?.name || '',
        employeeCode: people.get(String(u))?.employeeCode || '',
        // ROUTINE: already taken on — there is nothing to accept on today's
        // cash count, only to do. See config/tasks.isRoutineFrequency.
        ...(routine ? {
          status: STATUS.IN_PROGRESS,
          acceptance: ACCEPTANCE.ACCEPTED,
          acceptedAt: now,
          startedAt: now,
        } : {}),
      })),
      loopUsers,
      ...(schedule.onBehalf?.by ? { onBehalf: schedule.onBehalf } : {}),
      priority: schedule.priority,
      points: schedule.points,
      dueDate,
      startDate: appeared,
      // "Every 2 hours until done" counts from when the task showed up.
      remindFrom: appeared,
      routine,
      requiresApproval: routine ? false : schedule.requiresApproval !== false,
      // Copied, not referenced: explaining the weekly report once is the whole
      // saving, and the recording has to be on the row the doer opens.
      voiceNote: schedule.voiceNote,
      links: schedule.links,
      reminders: schedule.reminders,
      repeat: {
        frequency: schedule.frequency,
        weekdays: schedule.weekdays,
        monthDay: schedule.monthDay,
        month: schedule.month,
        interval: schedule.interval,
        monthlyMode: schedule.monthlyMode,
        nthWeek: schedule.nthWeek,
        weekday: schedule.weekday,
        time: schedule.time,
      },
      recurringTask: schedule._id,
      occurrenceKey,
    });

    await TaskUpdate.create({
      task: task._id,
      kind: 'CREATED',
      byName: 'System',
      to: task.status,
      note: routine
        ? 'Raised automatically — today’s routine. Mark it done when it is done.'
        : `Raised automatically — ${String(schedule.frequency).toLowerCase()} task.`,
      system: true,
    });

    notify.assigned(task, { _id: schedule.createdBy, firstName: schedule.createdByName || 'Your manager' })
      .catch((e) => console.error('recurring task notify failed:', e.message));

    return task;
  } catch (err) {
    // 11000 = the unique index did its job. Not an error: it means somebody
    // (another instance, an earlier run) already minted this day.
    if (err.code === 11000) return null;
    throw err;
  }
}

/**
 * Mint everything one schedule owes, up to now.
 *
 * Walks the IST days from the catch-up floor to `leadDays` ahead of today, and
 * mints each occurrence that falls due on one of them, has APPEARED by now, is
 * not due before `mintFrom`, and is not past the schedule's end.
 */
async function runSchedule(schedule, now = new Date()) {
  const made = [];
  const todayKey = occurrenceKeyFor(now);
  const untilKey = schedule.until ? occurrenceKeyFor(schedule.until) : null;
  if (untilKey && untilKey < todayKey) {
    // Expired. Switch it off so the sweep stops looking at it.
    await RecurringTask.updateOne({ _id: schedule._id }, { $set: { isActive: false } });
    return made;
  }

  const startKey = occurrenceKeyFor(schedule.startDate || now);
  const catchupKey = addDaysKey(todayKey, -CATCHUP_DAYS);
  // One day past the lead, so an occurrence due just after midnight — which
  // appears an hour before it — is found on the evening it appears.
  const endKey = addDaysKey(todayKey, leadDaysOf(schedule) + 1);
  const floor = schedule.mintFrom ? new Date(schedule.mintFrom) : null;

  let key = startKey > catchupKey ? startKey : catchupKey;
  for (; key <= endKey; key = addDaysKey(key, 1)) {
    if (untilKey && key > untilKey) break;
    if (!fallsOn(schedule, key)) continue;
    const due = atIST(key, schedule.time);
    if (floor && due < floor) continue;
    const appear = appearAt(schedule, key);
    if (appear > now) continue;
    // eslint-disable-next-line no-await-in-loop
    const task = await mintOccurrence(schedule, due, { key, appear, now });
    if (task) made.push(task);
  }

  if (made.length) {
    await RecurringTask.updateOne(
      { _id: schedule._id },
      {
        $set: { lastRunAt: now, lastOccurrenceKey: made[made.length - 1].occurrenceKey },
        $inc: { generatedCount: made.length },
      }
    );
  } else {
    await RecurringTask.updateOne({ _id: schedule._id }, { $set: { lastRunAt: now } });
  }
  return made;
}

/** One sweep over every live schedule. */
async function tick() {
  const now = new Date();
  let minted = 0;
  try {
    // A schedule that STARTS within the lead window still has to be looked at:
    // a monthly task first due on the 1st appears on the 29th.
    const horizon = new Date(now.getTime() + (MAX_LEAD_DAYS + 2) * DAY_MS);
    const schedules = await RecurringTask.find({ isActive: true, startDate: { $lte: horizon } }).lean();
    for (const schedule of schedules) {
      try {
        // eslint-disable-next-line no-await-in-loop
        minted += (await runSchedule(schedule, now)).length;
      } catch (err) {
        // One bad schedule must not stop the rest — the same rule every worker
        // in this portal follows.
        console.error(`Recurring task ${schedule._id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('Task recurrence sweep failed:', err.message);
  }
  if (minted) console.log(`Task recurrence: raised ${minted} task(s).`);
  return minted;
}

let timer = null;

function startWorker() {
  if (timer) return;
  // A first sweep shortly after boot rather than immediately: the database
  // connection and the models settle first, and a restart loop does not turn
  // into a mint loop.
  setTimeout(() => { tick().catch(() => {}); }, 30 * 1000);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log('Task recurrence worker started.');
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startWorker,
  stopWorker,
  tick,
  runSchedule,
  mintOccurrence,
  firstDueDate,
  nextOccurrence,
  appearAt,
  occurrenceKeyFor,
  fallsOn,
  atTime,
  atIST,
  addDaysKey,
  leadDaysOf,
  CATCHUP_DAYS,
};
