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
 *
 * ── ADDED 2026-09-27 ─────────────────────────────────────────────────────────
 *
 * 4. "EVERY 2 HOURS UNTIL DONE" — a repeating rule (config/tasks REMINDER_WHEN
 *    .EVERY), in one of four SHAPES (REMINDER_PATTERN): every N hours on the
 *    clock inside a window (9 am – 9 pm unless set), or once a day / on chosen
 *    weekdays / monthly at a set time. Each beat is a MOMENT, claimed on
 *    `repeatReminderAt` (the same conditional-update lock as rule 1), never
 *    sent late (rule 2 again) or within half an hour of the task appearing,
 *    and it stops the moment the work is done — or, for hourly ones, at the
 *    end of the due day's window; for the rest, a week past the deadline. It
 *    never reads or writes the bell's 30-minute gate: the user's rule is that
 *    an auto reminder goes on time even if a person rang five minutes earlier.
 *
 * 5. THE DEADLINE PASSING IS ANNOUNCED — once, to the people on it AND whoever
 *    set it: *"any task which gets overdue, the assigned and assignee get a
 *    notification automatically"*. Rule 2 applies here too, and it is what keeps
 *    the first run after deploy quiet: every task already overdue is stamped
 *    WITHOUT a word, and only tasks crossing their deadline from then on speak.
 */
const Task = require('../models/Task');
const User = require('../models/User');
const notify = require('./taskNotify');
const engine = require('./taskEngine');
const points = require('./taskPoints');
const { enqueueMail } = require('./email');
const recur = require('./taskRecurrenceWorker');
const {
  STATUS, reminderOffsetMinutes, reminderKey, reminderLabel,
  REMINDER_WHEN, REMINDER_CHANNEL, statusLabel, KIND_REQUEST,
  spellingsOf, REPEAT_REMINDER, ACCEPTANCE,
  REMINDER_PATTERN, reminderPattern, reminderWindow, repeatEveryMinutes, hhmmOf, DEFAULT_REMIND_AT,
} = require('../config/tasks');

/** How late a reminder may be and still be worth sending. See rule 2. */
const FIRING_WINDOW_MIN = 90;
/** How often the sweep runs. */
const TICK_MS = 5 * 60 * 1000;

const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
});
const IST_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Minutes past midnight, portal time. */
function istMinutes(ms) {
  const [h, m] = IST_PARTS.format(new Date(ms)).split(':').map((n) => parseInt(n, 10));
  return (h % 24) * 60 + m;
}

/** Inside the hours a repeating reminder may speak (rule 4)? The rule's own window, or 9 to 9. */
function inActiveHours(ms, rule = null) {
  const mins = istMinutes(ms);
  if (rule) {
    const w = reminderWindow(rule);
    return mins >= minutesOf(w.from) && mins <= minutesOf(w.to);
  }
  return mins >= REPEAT_REMINDER.activeFromHour * 60 && mins <= REPEAT_REMINDER.activeToHour * 60;
}

/** 'HH:mm' → minutes past midnight. */
function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

const pad2 = (n) => String(n).padStart(2, '0');
const hhmmFromMinutes = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

/**
 * A day-shaped rule as the schedule recurrence understands it, so "alternate
 * days", "Mon and Thu" and "the first Monday" are decided by the SAME code
 * that decides when a recurring task falls due (taskRecurrenceWorker.fallsOn).
 * "Every N days" counts from the day the task appeared.
 */
function asSchedule(rule, anchorMs) {
  const pattern = reminderPattern(rule);
  const frequency = pattern === REMINDER_PATTERN.WEEKLY ? 'WEEKLY'
    : pattern === REMINDER_PATTERN.MONTHLY ? 'MONTHLY' : 'DAILY';
  return {
    frequency,
    interval: Math.max(1, Math.round(Number(rule.amount) || 1)),
    weekdays: rule.weekdays,
    monthlyMode: rule.monthlyMode,
    monthDay: rule.monthDay,
    nthWeek: rule.nthWeek,
    weekday: rule.weekday,
    startDate: new Date(anchorMs),
  };
}

/** Every beat a rule has on one IST day ('YYYY-MM-DD'), as instants. */
function beatsOn(rule, key, anchorMs) {
  if (reminderPattern(rule) === REMINDER_PATTERN.HOURLY) {
    const w = reminderWindow(rule);
    const every = repeatEveryMinutes(rule);
    const out = [];
    for (let m = minutesOf(w.from); m <= minutesOf(w.to); m += every) {
      out.push(recur.atIST(key, hhmmFromMinutes(m)).getTime());
    }
    return out;
  }
  if (!recur.fallsOn(asSchedule(rule, anchorMs), key)) return [];
  return [recur.atIST(key, hhmmOf(rule.at) || DEFAULT_REMIND_AT).getTime()];
}

/**
 * The latest beat of a repeating rule at or before `nowMs` — `{ at }` or null.
 *
 * Only today and yesterday (IST) are looked at: an older beat is past the
 * firing window anyway (rule 2), and yesterday covers a beat just before
 * midnight read just after it. None falls within half an hour of the task
 * appearing — the New Task notification has only just said it.
 */
function latestBeat(rule, anchorMs, nowMs) {
  if (!Number.isFinite(anchorMs)) return null;
  const floor = anchorMs + REPEAT_REMINDER.minMinutes * 60 * 1000;
  const today = recur.occurrenceKeyFor(new Date(nowMs));
  for (const key of [today, recur.addDaysKey(today, -1)]) {
    const due = beatsOn(rule, key, anchorMs).filter((at) => at <= nowMs && at >= floor);
    if (due.length) return { at: Math.max(...due) };
  }
  return null;
}

/**
 * When a repeating rule has said all it usefully can, for a task due at
 * `dueMs`. An hourly one chases through the due day, to the end of its window
 * (a daily routine's next occurrence takes over the morning after); a
 * once-a-day, weekly or monthly one goes on past the deadline — "till
 * completed" — for a week.
 */
function beatsStopAt(rule, dueMs) {
  if (reminderPattern(rule) !== REMINDER_PATTERN.HOURLY) {
    return dueMs + REPEAT_REMINDER.dayPatternStopAfterDueMinutes * 60 * 1000;
  }
  const endOfDueDay = recur.atIST(recur.occurrenceKeyFor(new Date(dueMs)), reminderWindow(rule).to).getTime();
  return Math.max(dueMs, endOfDueDay);
}

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
  // SUBMITTED joins the two terminal ones: on a task on three people, the two
  // who have handed in should not be chased while the third is still working.
  const doers = (task.assignees || [])
    .filter((a) => !['COMPLETED', 'CANCELLED', 'SUBMITTED'].includes(a.status))
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

/** Everybody still doing it — not handed in, not finished, not refused. */
function stillDoing(task) {
  return (task.assignees || [])
    .filter((a) => !['COMPLETED', 'CANCELLED', 'SUBMITTED', 'Done'].includes(a.status)
      && a.acceptance !== ACCEPTANCE.REJECTED)
    .map((a) => String(a.user));
}

/**
 * One beat of a repeating rule (rule 4). No feed row: a line every two hours
 * would bury what people actually SAID on the task under the chasing.
 */
async function fireRepeat(task, rule) {
  const to = stillDoing(task);
  if (!to.length) return false;
  const late = task.dueDate && new Date(task.dueDate).getTime() < Date.now();
  const title = `Reminder: ${taskName(task)}`;
  const body = task.dueDate
    ? (late
      ? `Still not done — it was due ${fmt(task.dueDate)}.`
      : `Still to do — due ${fmt(task.dueDate)}.`)
    : 'Still to do.';
  if (rule.channel === REMINDER_CHANNEL.EMAIL) await mailTo(to, title, body, task);
  else await notify.reminder(task, to, { title, body, portal: 'employee' });
  return true;
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
      /**
       * CHASED means "still somebody's to do" — which is NOT the same as
       * OPEN_STATUS, and that is the bug this replaces.
       *
       * SUBMITTED is open (nothing further happens on its own) but the doer has
       * already handed the work in; the only person who can move it is the
       * approver. config/tasks.isOverdue was changed on 2026-09-22 so a
       * submitted task is never overdue — "painting it red in the doer's list
       * would blame them for somebody else's inbox" — and the counters follow
       * that rule. This worker did not, so an AFTER rule pushed
       * "Overdue: TSK-… is still in review" at exactly the person who had done
       * their part.
       *
       * `spellingsOf` because a QUERY cannot normalise: 51 of the 61 live rows
       * still hold the pre-rework word (ASSIGNED, Done, REJECTED), so naming
       * the current two would have swept almost nothing.
       */
      status: { $in: spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS) },
      'reminders.0': { $exists: true },
      archived: { $ne: true },
      // A deadline for the before/after rules; a repeating one needs none.
      $or: [{ dueDate: { $ne: null } }, { 'reminders.when': REMINDER_WHEN.EVERY }],
    })
      .select('code kind title description status dueDate reminders firedReminders assignees '
        + 'createdBy loopUsers remindFrom repeatReminderAt startDate createdAt')
      .limit(2000)
      .lean();

    for (const task of tasks) {
      const due = task.dueDate ? new Date(task.dueDate).getTime() : null;
      for (const rule of task.reminders || []) {
        // ===== Rule 4: a beat, not an offset =====
        if (rule.when === REMINDER_WHEN.EVERY) {
          const anchor = new Date(task.remindFrom || task.startDate || task.createdAt).getTime();
          const beat = latestBeat(rule, anchor, now.getTime());
          if (!beat) continue;
          if (task.repeatReminderAt && new Date(task.repeatReminderAt).getTime() >= beat.at) continue;
          // Said all it usefully can (beatsStopAt).
          if (due && beat.at > beatsStopAt(rule, due)) continue;
          // Too late to be worth sending — the server was down when it fell.
          // Nothing to claim: the next beat is a later moment anyway.
          if (now.getTime() - beat.at > FIRING_WINDOW_MIN * 60 * 1000) continue;
          // eslint-disable-next-line no-await-in-loop
          const won = await Task.updateOne(
            {
              _id: task._id,
              $or: [{ repeatReminderAt: { $lt: new Date(beat.at) } }, { repeatReminderAt: null }],
            },
            { $set: { repeatReminderAt: new Date(beat.at) } }
          );
          if (!won.modifiedCount) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            if (await fireRepeat(task, rule)) sent += 1;
          } catch (err) {
            console.error(`Task repeat reminder ${task._id} failed:`, err.message);
          }
          continue;
        }
        if (!due) continue;

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
 * Rule 5 — the deadline passing, said once to both sides.
 *
 * Two passes. Everything that went overdue longer ago than the firing window
 * is stamped in ONE silent update (the first run after a deploy finds every
 * task that is already late, and none of them is news any more). What crossed
 * its deadline inside the window is claimed row by row — the claim IS the lock,
 * so two instances cannot both announce it — and announced.
 */
async function overdueTick(now = new Date()) {
  let told = 0;
  const chased = spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS);
  const cutoff = new Date(now.getTime() - FIRING_WINDOW_MIN * 60 * 1000);
  try {
    await Task.updateMany(
      { status: { $in: chased }, archived: { $ne: true }, dueDate: { $lt: cutoff }, overdueNotifiedAt: null },
      { $set: { overdueNotifiedAt: now } }
    );

    const fresh = await Task.find({
      status: { $in: chased },
      archived: { $ne: true },
      dueDate: { $gte: cutoff, $lte: now },
      overdueNotifiedAt: null,
    })
      .select('code kind title status dueDate assignees createdBy createdByName approver approverName')
      .limit(500)
      .lean();

    for (const task of fresh) {
      // eslint-disable-next-line no-await-in-loop
      const won = await Task.updateOne(
        { _id: task._id, overdueNotifiedAt: null },
        { $set: { overdueNotifiedAt: now } }
      );
      if (!won.modifiedCount) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await notify.becameOverdue(task);
        // eslint-disable-next-line no-await-in-loop
        await engine.systemUpdate(task._id, `Now overdue — it was due ${fmt(task.dueDate)}. Everybody on it was told.`, 'OVERDUE');
        told += 1;
      } catch (err) {
        console.error(`Task overdue notice ${task._id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('Task overdue sweep failed:', err.message);
  }
  if (told) console.log(`Task overdue notices: ${told}.`);
  return told;
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

  // In PORTAL time (2026-09-27). `setHours` on the server's clock put the
  // "6 pm" digest at 11:30 pm, because the server runs in UTC.
  const day = IST_KEY.format(now);
  const pad = (n) => String(n).padStart(2, '0');
  const at = new Date(`${day}T${pad(h)}:${pad(Number.isFinite(m) ? m : 0)}:00+05:30`);
  const lateBy = (now.getTime() - at.getTime()) / 60000;
  if (lateBy < 0 || lateBy > FIRING_WINDOW_MIN) return 0;

  if (lastDigestDay === day) return 0;
  lastDigestDay = day;

  // Both stages name every spelling, for the same reason the sweep above does —
  // and the assignee-level one matters MORE, because `assignees[].status`
  // carries the identical legacy vocabulary (models/Task's assigneeSchema
  // enumerates it). Matching the two current words alone meant somebody whose
  // rows all said ASSIGNED got no evening digest at all, and everybody else's
  // count under-reported.
  const chased = spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS);
  const rows = await Task.aggregate([
    {
      $match: {
        status: { $in: chased },
        archived: { $ne: true },
      },
    },
    { $unwind: '$assignees' },
    { $match: { 'assignees.status': { $in: chased } } },
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
    overdueTick().catch(() => {});
    digestTick().catch(() => {});
  }, TICK_MS);
  console.log('Task reminder worker started.');
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startWorker, stopWorker, tick, overdueTick, digestTick, fire, fireRepeat, inActiveHours,
  latestBeat, beatsStopAt,
  FIRING_WINDOW_MIN,
};
