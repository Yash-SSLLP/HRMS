/**
 * Minting the occurrences of a repeating task.
 *
 * REWRITTEN 2026-09-21. "90% of the tasks you give are repetitive" — the daily
 * invoice, Friday's report, the monthly stock count. A RecurringTask is the
 * schedule; this turns it into ordinary Tasks, one per occurrence, which are
 * then worked, scored and reported exactly like a one-off. Nothing else in the
 * module knows recurrence exists.
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
 */
const RecurringTask = require('../models/RecurringTask');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const notify = require('./taskNotify');
const { FREQUENCY } = require('../config/tasks');

/** How far back a sleeping schedule may catch up. See the docblock. */
const CATCHUP_DAYS = 7;
/** How often the sweep runs. A schedule is never more urgent than this. */
const TICK_MS = 15 * 60 * 1000;

const IST = 'Asia/Kolkata';

/** "2026-09-21" for a date, in IST — the occurrence key's format. */
function occurrenceKeyFor(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(date));
}

/** A date at the schedule's time of day, in the server's zone. */
function atTime(date, hhmm = '18:00') {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  const d = new Date(date);
  d.setHours(Number.isFinite(h) ? h : 18, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/** Does this schedule fall due on this day? */
function fallsOn(schedule, day) {
  switch (schedule.frequency) {
    case FREQUENCY.DAILY:
      return true;
    case FREQUENCY.WEEKLY: {
      const days = schedule.weekdays?.length ? schedule.weekdays : [new Date(schedule.startDate).getDay()];
      return days.includes(day.getDay());
    }
    case FREQUENCY.MONTHLY: {
      const want = schedule.monthDay || new Date(schedule.startDate).getDate();
      // 29–31 clamp to the last day of a short month, so a "31st" schedule
      // still fires in February rather than silently skipping it.
      const lastOfMonth = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
      return day.getDate() === Math.min(want, lastOfMonth);
    }
    case FREQUENCY.YEARLY: {
      const wantM = (schedule.month || new Date(schedule.startDate).getMonth() + 1) - 1;
      const wantD = schedule.monthDay || new Date(schedule.startDate).getDate();
      const lastOfMonth = new Date(day.getFullYear(), wantM + 1, 0).getDate();
      return day.getMonth() === wantM && day.getDate() === Math.min(wantD, lastOfMonth);
    }
    default:
      return false;
  }
}

/**
 * The deadline of the FIRST occurrence of a schedule.
 *
 * Used by the create path so a freshly-repeating task has a date on it
 * immediately, rather than sitting dateless until the worker next wakes.
 */
function firstDueDate(schedule) {
  const start = new Date(schedule.startDate || Date.now());
  for (let i = 0; i < 400; i += 1) {
    const day = addDays(start, i);
    if (fallsOn(schedule, day)) return atTime(day, schedule.time);
  }
  return atTime(start, schedule.time);
}

/** Build one occurrence from a schedule. Returns null if it already exists. */
async function mintOccurrence(schedule, dueDate) {
  const occurrenceKey = occurrenceKeyFor(dueDate);
  try {
    const task = await Task.create({
      title: schedule.title,
      description: schedule.description,
      category: schedule.category,
      company: schedule.company,
      createdBy: schedule.createdBy,
      createdByName: schedule.createdByName,
      assignees: (schedule.assignees || []).map((u) => ({ user: u })),
      loopUsers: schedule.loopUsers,
      ...(schedule.onBehalf?.by ? { onBehalf: schedule.onBehalf } : {}),
      priority: schedule.priority,
      points: schedule.points,
      dueDate,
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
      note: `Raised automatically — ${String(schedule.frequency).toLowerCase()} task.`,
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

/** Mint everything one schedule owes, up to today. */
async function runSchedule(schedule, now = new Date()) {
  const made = [];
  const start = new Date(schedule.startDate);
  if (start > now) return made;
  if (schedule.until && new Date(schedule.until) < now) {
    // Expired. Switch it off so the sweep stops looking at it.
    await RecurringTask.updateOne({ _id: schedule._id }, { $set: { isActive: false } });
    return made;
  }

  // The window: from the later of the start date and the catch-up floor, to
  // today. Never further back — see the docblock.
  const floor = addDays(now, -CATCHUP_DAYS);
  let cursor = start > floor ? new Date(start) : floor;
  cursor.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  while (cursor <= end) {
    if (fallsOn(schedule, cursor)) {
      if (!schedule.until || cursor <= new Date(schedule.until)) {
        const task = await mintOccurrence(schedule, atTime(cursor, schedule.time));
        if (task) made.push(task);
      }
    }
    cursor = addDays(cursor, 1);
  }

  if (made.length) {
    await RecurringTask.updateOne(
      { _id: schedule._id },
      {
        $set: { lastRunAt: now, lastOccurrenceKey: occurrenceKeyFor(made[made.length - 1].dueDate) },
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
    const schedules = await RecurringTask.find({ isActive: true, startDate: { $lte: now } }).lean();
    for (const schedule of schedules) {
      try {
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
  startWorker, stopWorker, tick, runSchedule, mintOccurrence,
  firstDueDate, occurrenceKeyFor, fallsOn, atTime, CATCHUP_DAYS,
};
