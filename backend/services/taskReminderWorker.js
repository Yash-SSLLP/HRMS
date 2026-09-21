/**
 * Chasing — so that nobody has to.
 *
 * REWRITTEN 2026-09-21. "Till now you were reminding your teammates; now the
 * system reminds your teammates." A task carries a list of rules — "1 day
 * before", "4 hours before", "1 day after" — and this fires them.
 *
 * THREE RULES, AND EACH OF THEM IS THERE BECAUSE SOMETHING WENT WRONG ONCE.
 *
 * 1. A RULE FIRES AT MOST ONCE. Every fired rule is recorded on the task as a
 *    `config/tasks.reminderKey` string in `firedReminders`, and the claim is
 *    made with a CONDITIONAL update ($ne on that key) so two instances racing
 *    the same tick cannot both send it. This is the trap the attendance push
 *    worker hit: a restart replayed a day of notifications at everybody.
 *
 * 2. NOTHING OLDER THAN THE WINDOW FIRES AT ALL. A rule whose moment passed
 *    more than FIRING_WINDOW_MIN ago is marked fired WITHOUT being sent. A
 *    server that was down overnight must not wake up and deliver yesterday's
 *    four reminders at breakfast, and a task module's first version really did
 *    send 51 overdue pushes on its first morning.
 *
 * 3. AFTER-DEADLINE REMINDERS GO UP, NOT JUST ACROSS. A "before" reminder goes
 *    to the people doing the work. An "after" one goes to them AND to whoever
 *    set it and whoever is in the loop, because at that point it is news the
 *    assigner needs rather than a nudge the doer has already ignored.
 */
const Task = require('../models/Task');
const User = require('../models/User');
const notify = require('./taskNotify');
const engine = require('./taskEngine');
const points = require('./taskPoints');
const { enqueueMail } = require('./email');
const {
  STATUS, OPEN_STATUS, reminderOffsetMinutes, reminderKey, reminderLabel,
  REMINDER_WHEN, REMINDER_CHANNEL, statusLabel, KIND_REQUEST,
} = require('../config/tasks');

/** How late a reminder may be and still be worth sending. See rule 2. */
const FIRING_WINDOW_MIN = 90;
/** How often the sweep runs. */
const TICK_MS = 5 * 60 * 1000;

const fmt = (d) => new Date(d).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  hour12: true, timeZone: 'Asia/Kolkata',
});

const noun = (task) => (task.kind === KIND_REQUEST ? 'request' : 'task');
const taskName = (task) => (task.code ? `${task.code} — ${task.title}` : `"${task.title}"`);

/**
 * Claim a rule for sending.
 *
 * The conditional update IS the lock: if the key is already in `firedReminders`
 * nothing matches, and the caller knows somebody else has it.
 */
async function claim(taskId, key) {
  const r = await Task.updateOne(
    { _id: taskId, firedReminders: { $ne: key } },
    { $addToSet: { firedReminders: key } }
  );
  return r.modifiedCount > 0;
}

/** Who hears about this rule. See rule 3. */
function audienceFor(task, rule) {
  const doers = (task.assignees || [])
    .filter((a) => !['COMPLETED', 'CANCELLED'].includes(a.status))
    .map((a) => String(a.user));

  if (rule.when !== REMINDER_WHEN.AFTER) return { to: doers, portal: 'employee' };

  const overseers = [
    String(task.createdBy || ''),
    ...(task.loopUsers || []).map(String),
  ].filter(Boolean);
  return { to: doers, portal: 'employee', alsoTo: [...new Set(overseers)] };
}

/** Send one rule's reminder. */
async function fire(task, rule) {
  const { to, alsoTo } = audienceFor(task, rule);
  const when = reminderLabel(rule);
  const label = noun(task);

  if (to.length) {
    const title = rule.when === REMINDER_WHEN.AFTER
      ? `Overdue: ${taskName(task)}`
      : `Reminder: ${taskName(task)}`;
    const body = rule.when === REMINDER_WHEN.AFTER
      ? `This ${label} was due ${fmt(task.dueDate)} and is still ${statusLabel(task.status, task.kind).toLowerCase()}.`
      : `Due ${fmt(task.dueDate)} — ${when}.`;

    if (rule.channel === REMINDER_CHANNEL.EMAIL) {
      await mailTo(to, title, body, task);
    } else {
      await notify.reminder(task, to, { title, body, portal: 'employee' });
    }
  }

  if (alsoTo?.length) {
    const who = (task.assignees || []).map((a) => a.name).filter(Boolean).join(', ');
    const title = `Still not done: ${taskName(task)}`;
    const body = `Due ${fmt(task.dueDate)}${who ? ` · ${who}` : ''}.`;
    if (rule.channel === REMINDER_CHANNEL.EMAIL) await mailTo(alsoTo, title, body, task);
    else await notify.reminder(task, alsoTo, { title, body, portal: 'admin' });
  }

  // The feed records that the chase happened, so "did anybody tell them?" is
  // answerable from the task rather than from a log nobody can read.
  await engine.systemUpdate(
    task._id,
    `Reminder sent — ${when}${rule.channel === REMINDER_CHANNEL.EMAIL ? ' (email)' : ''}.`
  );
}

/** Email reminders go through the existing queue, not a direct send. */
async function mailTo(userIds, subject, body, task) {
  try {
    const users = await User.find({ _id: { $in: userIds }, isActive: true })
      .select('email firstName').lean();
    for (const u of users) {
      if (!u.email) continue;
      await enqueueMail({
        to: u.email,
        subject,
        html: `<p>Hi ${u.firstName || ''},</p><p>${body}</p>`
          + `<p><strong>${taskName(task)}</strong></p>`
          + (task.description ? `<p>${String(task.description).slice(0, 500)}</p>` : ''),
        // Nobody triggered this, so nobody is Cc'd. Said explicitly rather than
        // relying on the request context being empty: a worker that ever runs
        // inside one would otherwise copy whoever happened to be signed in.
        selfCopy: false,
      }, { type: 'Task', id: task._id });
    }
  } catch (err) {
    console.error('Task reminder email failed:', err.message);
  }
}

/**
 * One sweep.
 *
 * Only tasks that are OPEN and have both a deadline and at least one rule are
 * even looked at — everything else cannot produce a reminder, and scanning it
 * every five minutes is work for nothing.
 */
async function tick(now = new Date()) {
  let sent = 0;
  try {
    const tasks = await Task.find({
      status: { $in: OPEN_STATUS },
      dueDate: { $ne: null },
      'reminders.0': { $exists: true },
      archived: { $ne: true },
    })
      .select('code kind title description status dueDate reminders firedReminders assignees '
        + 'createdBy loopUsers')
      .limit(2000)
      .lean();

    for (const task of tasks) {
      const due = new Date(task.dueDate).getTime();
      for (const rule of task.reminders || []) {
        const key = reminderKey(rule);
        if ((task.firedReminders || []).includes(key)) continue;

        const at = due + reminderOffsetMinutes(rule) * 60 * 1000;
        if (at > now.getTime()) continue;              // not yet

        const lateBy = (now.getTime() - at) / 60000;
        if (lateBy > FIRING_WINDOW_MIN) {
          // Rule 2: too old to be useful. Burn the key so it never fires, and
          // say nothing.
          await claim(task._id, key);
          continue;
        }

        if (!(await claim(task._id, key))) continue;   // somebody else has it
        try {
          await fire(task, rule);
          sent += 1;
        } catch (err) {
          console.error(`Task reminder ${task._id} ${key} failed:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Task reminder sweep failed:', err.message);
  }
  if (sent) console.log(`Task reminders: sent ${sent}.`);
  return sent;
}

/**
 * The evening summary — "you have 4 tasks pending".
 *
 * One notification per person instead of one per task, fired once a day at the
 * time a SuperAdmin set (Setting.tasks.dailyDigestAt). Guarded by the same
 * window rule: a server that boots at midnight does not deliver the six
 * o'clock digest six hours late.
 */
let lastDigestDay = null;

async function digestTick(now = new Date()) {
  const { dailyDigestAt } = await points.taskSettings();
  if (!dailyDigestAt) return 0;

  const [h, m] = dailyDigestAt.split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(h)) return 0;

  const at = new Date(now);
  at.setHours(h, m || 0, 0, 0);
  const lateBy = (now.getTime() - at.getTime()) / 60000;
  if (lateBy < 0 || lateBy > FIRING_WINDOW_MIN) return 0;

  const day = now.toDateString();
  if (lastDigestDay === day) return 0;
  lastDigestDay = day;

  const rows = await Task.aggregate([
    {
      $match: {
        status: { $in: [STATUS.PENDING, STATUS.IN_PROGRESS] },
        archived: { $ne: true },
      },
    },
    { $unwind: '$assignees' },
    { $match: { 'assignees.status': { $in: [STATUS.PENDING, STATUS.IN_PROGRESS] } } },
    {
      $group: {
        _id: '$assignees.user',
        pending: { $sum: 1 },
        overdue: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] },
              1, 0,
            ],
          },
        },
      },
    },
  ]);

  let sent = 0;
  for (const r of rows) {
    try {
      await notify.digest(r._id, { pending: r.pending, overdue: r.overdue });
      sent += 1;
    } catch (err) {
      console.error('Task digest failed:', err.message);
    }
  }
  if (sent) console.log(`Task digest: sent ${sent}.`);
  return sent;
}

let timer = null;

function startWorker() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => {});
    digestTick().catch(() => {});
  }, TICK_MS);
  console.log('Task reminder worker started.');
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startWorker, stopWorker, tick, digestTick, fire, FIRING_WINDOW_MIN };
