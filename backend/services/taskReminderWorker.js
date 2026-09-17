/**
 * The reminder and escalation worker (sections 19–20).
 *
 * Wakes every few minutes and does four passes over the open tasks:
 *   1. deadlines coming up      → nudge the assignee;
 *   2. deadlines gone past      → nudge, then climb the ladder to the
 *                                 supervisor, the manager, and finally the
 *                                 `tasks.manage` bench;
 *   3. tasks nobody accepted    → nudge, then tell whoever handed it over;
 *   4. workflow steps past SLA  → tell the approver, then escalate;
 *      and 'wait' steps whose time is up, which it advances.
 *
 * IT CANNOT REPLAY, AND THAT IS THE WHOLE DESIGN. Every notification is keyed
 * ('due:24', 'over:2', 'accept:1', 'step:onboarding-hr:sla') and the key is
 * written onto `Task.firedReminders` in the SAME update that decides to send it.
 * A restart, a second API instance, or a clock stepping backwards therefore
 * cannot fire the same reminder twice — which is exactly the trap the push
 * reminder worker hit, where a restart replayed a whole day of pushes at
 * everybody at once.
 *
 * Same lightweight pattern as the other five workers in this app: an interval
 * tick, started from server.js, that is idempotent and logs what it did.
 */
const Task = require('../models/Task');
const notify = require('./taskNotify');
const engine = require('./taskEngine');
const access = require('./taskAccess');
const flow = require('./taskWorkflow');
const { ACCEPT_WINDOW_HOURS, isTerminal, normaliseStatus } = require('../config/taskWorkflow');

// Five minutes. Fine enough that "15 minutes before due" means roughly that,
// coarse enough that a portal with fifty thousand tasks is not re-scanned
// constantly — the query is indexed and only looks at what is actually open.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// How far before a deadline to nudge, when a task does not say. The spec's own
// ladder: a day, four hours, an hour, a quarter of an hour.
const DEFAULT_BEFORE_DUE_HOURS = [24, 4, 1, 0.25];

// Who hears about a deadline that has passed, and how long after. The rungs are
// the spec's: the assignee first, twice; then the supervisor; then the manager;
// then HR.
const DEFAULT_AFTER_DUE = [
  { hours: 0.25, to: 'assignee', severity: 'HIGH' },
  { hours: 1, to: 'assignee', severity: 'HIGH' },
  { hours: 2, to: 'supervisor', severity: 'HIGH' },
  { hours: 24, to: 'manager', severity: 'HIGH' },
  { hours: 48, to: 'admin', severity: 'CRITICAL' },
];

// How far past its deadline a task can be, with no reminder ever fired, before
// this worker treats it as BACKLOG rather than as news — see the backlog rule
// in sweepDeadlines. Two days: a task that goes overdue while the worker is
// running has its first rung claimed within five minutes, so anything this
// late with a clean slate went past while nothing was watching.
const BACKLOG_GRACE_HOURS = Number(process.env.TASK_REMINDER_BACKLOG_HOURS) || 48;

// Statuses a reminder is pointless on. A submitted task is not the assignee's
// problem any more — chasing them for it would be telling somebody off for work
// they have already handed in.
const NOT_CHASED = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'COMPLETED', 'CANCELLED', 'DECLINED', 'ON_HOLD', 'Done'];

/**
 * Claim a reminder key for a task, atomically.
 *
 * `$addToSet` with the key absent from the filter is a single conditional update:
 * whoever wins the write gets `true` and sends, and every other caller — another
 * instance, the same instance after a restart — gets `false` and stays quiet.
 * This is the whole idempotence story, and it lives in the database rather than
 * in a variable this process holds.
 *
 * @param {*} taskId
 * @param {string} key
 * @returns {Promise<boolean>} true when this caller should send
 */
async function claim(taskId, key) {
  const result = await Task.updateOne(
    { _id: taskId, firedReminders: { $ne: key } },
    { $addToSet: { firedReminders: key } }
  );
  return result.modifiedCount === 1;
}

/** Who to send an overdue notice to, for a rung of the ladder. */
async function rungRecipients(task, to) {
  const who = access.audienceOf(task);
  switch (to) {
    case 'assignee':
      return who.assignees;
    case 'supervisor':
      return [task.supervisor].filter(Boolean);
    case 'manager':
      return [task.manager || task.supervisor].filter(Boolean);
    case 'admin':
    default: {
      const bench = await access.managerBench(task, task.company);
      return bench.length ? bench : [task.createdBy].filter(Boolean);
    }
  }
}

/**
 * One pass over tasks with a deadline in the next day or already past it.
 * @returns {Promise<{reminded:number, escalated:number}>}
 */
async function sweepDeadlines() {
  const now = Date.now();
  const horizon = new Date(now + 25 * 3600000); // the widest default is 24h

  const tasks = await Task.find({
    archived: { $ne: true },
    dueDate: { $ne: null, $lte: horizon },
    status: { $nin: NOT_CHASED },
  })
    .select('code title dueDate priority status assignees assignedTo supervisor manager createdBy company firedReminders escalationLevel firstOverdueAt reminders')
    .limit(2000)
    .lean();

  let reminded = 0;
  let escalated = 0;
  let adopted = 0;

  for (const task of tasks) {
    const due = new Date(task.dueDate).getTime();
    const hoursToDue = (due - now) / 3600000;

    // ----- coming up -----
    if (hoursToDue > 0) {
      const ladder = (task.reminders && task.reminders.beforeDueHours && task.reminders.beforeDueHours.length)
        ? task.reminders.beforeDueHours
        : DEFAULT_BEFORE_DUE_HOURS;
      // Only the CLOSEST rung that has been reached — otherwise a task created
      // an hour before its deadline would fire all four at once.
      const reached = ladder.filter((h) => hoursToDue <= h).sort((a, b) => a - b)[0];
      if (reached != null) {
        const key = `due:${reached}`;
        if (await claim(task._id, key)) {
          const who = access.audienceOf(task);
          await notify.dueSoon(task, who.assignees, reached);
          reminded += 1;
        }
      }
      continue;
    }

    // ----- gone past -----
    const hoursLate = (now - due) / 3600000;

    // Stamp the first time it went late. Kept even if an extension later moves
    // the deadline: it DID miss one, and an extension must not quietly rewrite
    // that (it is what the analytics count).
    if (!task.firstOverdueAt) {
      await Task.updateOne({ _id: task._id, firstOverdueAt: null }, { $set: { firstOverdueAt: new Date() } });
    }

    // ----- THE BACKLOG RULE -----
    // A task that is days overdue and has NEVER had a single overdue reminder
    // fired went past its deadline while nothing was watching. That is backlog,
    // not news: chasing it now would fire a wave of "overdue!" pushes at people
    // about work from last week, all at once, the moment this worker first runs
    // — which is exactly what happened here, where 51 open tasks were carried
    // over from before the module was reworked.
    //
    // So it is ADOPTED QUIETLY: every rung it has already passed is claimed
    // without sending anything, and the task is chased normally from here on if
    // it slips further. A task that goes overdue while the worker IS running has
    // its first rung claimed within five minutes, so it can never look like
    // backlog — which is what makes "no `over:` key at all" a safe signal even
    // after a long outage.
    const everChased = (task.firedReminders || []).some((k) => k.startsWith('over:'));
    if (!everChased && hoursLate > BACKLOG_GRACE_HOURS) {
      const ladder = (task.reminders && task.reminders.afterDue && task.reminders.afterDue.length)
        ? task.reminders.afterDue
        : DEFAULT_AFTER_DUE;
      const passed = ladder.filter((r) => hoursLate >= r.hours).map((r) => `over:${r.hours}:${r.to}`);
      if (passed.length) {
        await Task.updateOne({ _id: task._id }, { $addToSet: { firedReminders: { $each: passed } } });
        adopted += 1;
      }
      continue;
    }

    const ladder = (task.reminders && task.reminders.afterDue && task.reminders.afterDue.length)
      ? task.reminders.afterDue
      : DEFAULT_AFTER_DUE;

    // The furthest rung reached, one at a time per tick, so a task that has been
    // late for a week does not fire five notices in one go.
    const rung = [...ladder]
      .filter((r) => hoursLate >= r.hours)
      .sort((a, b) => b.hours - a.hours)[0];
    if (!rung) continue;

    const key = `over:${rung.hours}:${rung.to}`;
    if (!(await claim(task._id, key))) continue;

    const recipients = await rungRecipients(task, rung.to);
    if (!recipients.length) continue;

    await notify.overdue(task, recipients, { hoursLate, to: rung.to, severity: rung.severity });

    if (rung.to !== 'assignee') {
      escalated += 1;
      await Task.updateOne(
        { _id: task._id },
        { $set: { escalationLevel: (task.escalationLevel || 0) + 1, lastEscalatedAt: new Date() } }
      );
      await engine.logActivity({
        task: task._id,
        kind: 'escalated',
        system: true,
        message: `Escalated to ${rung.to} — ${Math.round(hoursLate)} hours overdue`,
      });
    } else {
      reminded += 1;
      await engine.logActivity({
        task: task._id,
        kind: 'reminder',
        system: true,
        message: `Overdue reminder sent — ${Math.round(hoursLate)} hours late`,
      });
    }
  }

  return { reminded, escalated, adopted };
}

/**
 * One pass over tasks handed out and not yet accepted (section 10).
 * @returns {Promise<{chased:number}>}
 */
async function sweepUnaccepted() {
  const now = Date.now();
  const tasks = await Task.find({
    archived: { $ne: true },
    status: { $in: ['ASSIGNED', 'Todo'] },
    assignedAt: { $ne: null },
  })
    .select('code title priority status assignees assignedTo supervisor manager createdBy company assignedAt firedReminders reminders dueDate')
    .limit(2000)
    .lean();

  let chased = 0;
  let adopted = 0;
  for (const task of tasks) {
    const window = (task.reminders && task.reminders.acceptWithinHours)
      || ACCEPT_WINDOW_HOURS[task.priority]
      || ACCEPT_WINDOW_HOURS.Medium;
    const waiting = (now - new Date(task.assignedAt).getTime()) / 3600000;
    if (waiting < window) continue;

    // The same backlog rule sweepDeadlines applies, for the same reason. A task
    // handed over days ago and never accepted, with no acceptance reminder ever
    // fired, was handed over while nothing was watching — chasing it now would
    // fire a wave at everybody at once. Adopt it quietly and chase it from here.
    const everChased = (task.firedReminders || []).some((k) => k.startsWith('accept:'));
    if (!everChased && waiting > BACKLOG_GRACE_HOURS) {
      await Task.updateOne(
        { _id: task._id },
        { $addToSet: { firedReminders: { $each: ['accept:assignee', 'accept:supervisor'] } } }
      );
      adopted += 1;
      continue;
    }

    // The assignee first; whoever handed it over once the window has doubled.
    const stage = waiting >= window * 2 ? 'supervisor' : 'assignee';
    const key = `accept:${stage}`;
    if (!(await claim(task._id, key))) continue;

    const who = access.audienceOf(task);
    const recipients = stage === 'assignee'
      ? who.assignees
      : (who.reviewers.length ? who.reviewers : await access.managerBench(task, task.company));
    if (!recipients.length) continue;

    await notify.notAccepted(task, recipients, { to: stage, hours: waiting });
    await engine.logActivity({
      task: task._id,
      kind: stage === 'assignee' ? 'reminder' : 'escalated',
      system: true,
      message: `Not accepted after ${Math.round(waiting)} hours — ${stage === 'assignee' ? 'reminded the assignee' : 'told the supervisor'}`,
    });
    chased += 1;
  }
  return { chased, adopted };
}

/**
 * One pass over open workflow steps: chase the ones past their SLA, and advance
 * the 'wait' steps whose time is up.
 * @returns {Promise<{chased:number, advanced:number}>}
 */
async function sweepWorkflowSteps() {
  const now = new Date();
  const tasks = await Task.find({
    archived: { $ne: true },
    currentStepKey: { $ne: null },
    status: { $nin: ['COMPLETED', 'CANCELLED', 'DECLINED'] },
    'workflowSteps.dueAt': { $lte: now },
  }).limit(500);

  let chased = 0;
  let advanced = 0;

  for (const task of tasks) {
    const open = (task.workflowSteps || []).filter((s) => s.status === 'Pending' && s.dueAt && s.dueAt <= now);
    for (const step of open) {
      // A 'wait' step is not late — its time has simply come.
      if (step.type === 'wait') {
        step.status = 'Done';
        step.completedAt = now;
        await engine.logActivity({
          task: task._id, kind: 'stepDecided', system: true,
          message: `"${step.name}" finished waiting`,
        });
        const result = await flow.open(task, flow.nextStepOf(task, step));
        await task.save();
        if (result.done) {
          try {
            const done = await engine.transition(task, 'APPROVED', null, { system: true, message: 'Workflow finished' });
            const completed = await engine.transition(done, 'COMPLETED', null, { system: true, message: 'Workflow finished' });
            const { onCompleted } = require('../controllers/taskController');
            await onCompleted(completed, null);
          } catch (err) {
            // A task that cannot legally reach APPROVED from where it is (it was
            // cancelled while waiting, say) is not an error — the workflow is
            // simply no longer the thing deciding.
            console.log(`Task workflow finished but the task could not complete: ${err.message}`);
          }
        }
        advanced += 1;
        continue;
      }

      const hoursLate = (now.getTime() - new Date(step.dueAt).getTime()) / 3600000;
      const level = hoursLate >= 48 ? 3 : hoursLate >= 24 ? 2 : 1;
      const key = `step:${step.key}:${level}`;
      if (!(await claim(task._id, key))) continue;

      const recipients = level === 1
        ? (step.actors || []).map((a) => a.user)
        : level === 2
          ? [task.supervisor, task.manager].filter(Boolean)
          : await access.managerBench(task, task.company);
      if (!recipients.length) continue;

      await notify.escalated(task, recipients, level, `"${step.name}" has been waiting ${Math.round(hoursLate)} hours`);
      await engine.logActivity({
        task: task._id, kind: 'escalated', system: true,
        message: `"${step.name}" is ${Math.round(hoursLate)} hours past its deadline — escalated (level ${level})`,
      });
      chased += 1;
    }
  }

  return { chased, advanced };
}

/**
 * One full tick. Every pass is independent and swallows its own errors, so a
 * failure in one does not stop the others — a broken escalation must not also
 * silence every reminder.
 * @returns {Promise<void>}
 */
async function tick() {
  const results = [];
  for (const [name, fn] of [
    ['deadlines', sweepDeadlines],
    ['acceptance', sweepUnaccepted],
    ['workflow steps', sweepWorkflowSteps],
  ]) {
    try {
      results.push([name, await fn()]);
    } catch (err) {
      console.error(`Task reminder worker (${name}) failed:`, err.message);
    }
  }

  const summary = results
    .map(([name, r]) => {
      const bits = Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
      return bits.length ? `${name}: ${bits.join(', ')}` : null;
    })
    .filter(Boolean);
  if (summary.length) console.log(`Task reminders — ${summary.join('; ')}`);
}

/**
 * Start the worker: a catch-up tick shortly after boot, then every five minutes.
 *
 * The delay matters. Every other worker in this app does the same, and for the
 * same reason: the database connection has to be up, and a boot that coincides
 * with a deployment should not have three instances all sweeping at once —
 * though the `claim` guard means that would be harmless if it did.
 * @returns {void}
 */
function startWorker() {
  setTimeout(tick, 30_000);
  setInterval(tick, POLL_INTERVAL_MS);
  console.log('Task reminder & escalation worker started (every 5 minutes)');
}

module.exports = { startWorker, tick, sweepDeadlines, sweepUnaccepted, sweepWorkflowSteps, claim };
