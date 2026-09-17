/**
 * The recurring-task generator (section 23).
 *
 * Wakes every fifteen minutes, finds the schedules that are due, and creates the
 * next instance of each one from its template. Twelve monthly tasks in a year
 * are twelve ordinary Tasks, each with its own code, deadline and history,
 * pointing back at the schedule through `Task.recurringTask`.
 *
 * IT CANNOT MINT THE SAME DAY TWICE, and not because the worker is careful.
 * Every generated task carries `occurrenceKey` — the IST day the occurrence is
 * FOR — and Task has a UNIQUE index on (recurringTask, occurrenceKey). A
 * restart mid-sweep, two API instances, or a clock stepping backwards all end
 * with the database refusing the duplicate, which this file then treats as "it
 * already exists" rather than as an error. Idempotence in the schema beats
 * idempotence in a function.
 */
const RecurringTask = require('../models/RecurringTask');
const TaskTemplate = require('../models/TaskTemplate');
const Task = require('../models/Task');
const { nextOccurrence, occurrenceKeyFor } = require('../models/RecurringTask');
const { buildTaskFromTemplate } = require('./taskTemplates');
const engine = require('./taskEngine');
const flow = require('./taskWorkflow');
const notify = require('./taskNotify');

const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Create the next instance of one schedule, if one is due.
 *
 * @param {object} rule - a RecurringTask document
 * @param {object} [opts]
 * @param {boolean} [opts.force] - make the next one now, whatever the clock says
 * @param {object} [opts.actor] - who asked (for a manual run)
 * @returns {Promise<object|null>} the task, or null when nothing was due
 */
async function generateOne(rule, opts = {}) {
  const now = new Date();

  if (!rule.active && !opts.force) return null;
  if (rule.maxOccurrences && rule.generatedCount >= rule.maxOccurrences) return null;
  if (rule.endsOn && now > new Date(rule.endsOn) && !opts.force) return null;

  // Which occurrence are we making? The next one at or after whatever we last
  // made — not "now" — so a worker that was down for a day still catches up
  // rather than silently skipping the day it missed.
  const from = rule.lastGeneratedAt
    ? new Date(new Date(rule.lastGeneratedAt).getTime() + 60000)
    : new Date(rule.startsOn);
  const occurrence = nextOccurrence(rule, from);
  if (!occurrence) return null;

  // Not yet, unless it is inside the lead time (a monthly audit that appears a
  // week early is useful) or somebody asked for it by hand.
  const dueAt = occurrence.getTime() - (rule.leadDays || 0) * 86400000;
  if (!opts.force && dueAt > now.getTime()) {
    if (!rule.nextRunAt || rule.nextRunAt.getTime() !== occurrence.getTime()) {
      rule.nextRunAt = occurrence;
      await rule.save();
    }
    return null;
  }

  const tpl = await TaskTemplate.findById(rule.template);
  if (!tpl) {
    console.error(`Recurring "${rule.name}": its template is gone; deactivating the schedule.`);
    rule.active = false;
    await rule.save();
    return null;
  }

  const key = occurrenceKeyFor(occurrence);

  // Cheap pre-check so the common case does not rely on catching an error. The
  // unique index is still what guarantees it.
  const already = await Task.findOne({ recurringTask: rule._id, occurrenceKey: key }).select('_id').lean();
  if (already) {
    rule.lastOccurrenceKey = key;
    rule.lastGeneratedAt = occurrence;
    rule.nextRunAt = nextOccurrence(rule, new Date(occurrence.getTime() + 60000));
    await rule.save();
    return null;
  }

  const fields = await buildTaskFromTemplate(tpl, {
    actor: opts.actor || { _id: rule.createdBy },
    subject: rule.subject,
    at: occurrence,
  });

  const { subtasks, workflow, ...taskFields } = fields;

  const task = new Task({
    ...taskFields,
    createdBy: rule.createdBy,
    company: taskFields.company || rule.company,
    recurringTask: rule._id,
    occurrenceKey: key,
  });

  if (workflow) {
    try {
      await flow.start(task, workflow);
    } catch (err) {
      // A workflow that cannot start must not stop the task existing — the work
      // still has to be done, and an unrouted task is far better than none.
      console.error(`Recurring "${rule.name}": workflow could not start — ${err.message}`);
    }
  }

  try {
    await task.save();
  } catch (err) {
    if (err && err.code === 11000) {
      // Somebody else won the race. Exactly what the index is for.
      return null;
    }
    throw err;
  }

  rule.lastOccurrenceKey = key;
  rule.lastGeneratedAt = occurrence;
  rule.generatedCount = (rule.generatedCount || 0) + 1;
  rule.nextRunAt = nextOccurrence(rule, new Date(occurrence.getTime() + 60000));
  await rule.save();

  await engine.logActivity({
    task: task._id,
    kind: 'created',
    by: opts.actor,
    system: !opts.actor,
    message: `Created automatically from the schedule "${rule.name}"`,
    refModel: 'RecurringTask',
    refId: rule._id,
  });

  // The subtasks the template asked for.
  for (const st of subtasks || []) {
    if (!String(st.title || '').trim()) continue;
    const child = new Task({
      title: st.title,
      description: st.description,
      parentTask: task._id,
      department: task.department,
      company: task.company,
      priority: st.priority || task.priority,
      dueDate: st.dueDate || task.dueDate,
      assignees: (st.assignees || []).map((u, i) => ({ user: u, role: i === 0 ? 'Owner' : 'Contributor' })),
      supervisor: task.supervisor,
      createdBy: rule.createdBy,
    });
    await child.save();
  }
  if ((subtasks || []).length) await engine.recomputeRollups(task._id);

  if ((task.assignees || []).length) {
    notify.assigned(task, task.assignees.map((a) => a.user), opts.actor || null).catch(() => {});
  }

  await TaskTemplate.updateOne({ _id: tpl._id }, { $inc: { usageCount: 1 } });

  return task;
}

/**
 * One pass over every schedule that is due.
 *
 * `nextRunAt` is what the query filters on, so a hundred dormant schedules cost
 * one indexed lookup rather than a hundred date computations.
 * @returns {Promise<{created:number}>}
 */
async function tick() {
  try {
    const now = new Date();
    const due = await RecurringTask.find({
      active: true,
      $or: [{ nextRunAt: { $lte: now } }, { nextRunAt: null }],
    }).limit(200);

    let created = 0;
    for (const rule of due) {
      try {
        // A catch-up loop: a worker that was down for a week makes the instances
        // it missed rather than only the latest. Capped, so a schedule with a
        // start date years ago cannot produce a thousand tasks in one tick.
        for (let i = 0; i < 10; i += 1) {
          const task = await generateOne(rule);
          if (!task) break;
          created += 1;
        }
      } catch (err) {
        console.error(`Recurring task "${rule.name}" failed:`, err.message);
      }
    }

    if (created) console.log(`Recurring tasks: created ${created}`);
    return { created };
  } catch (err) {
    console.error('Task recurrence worker tick failed:', err.message);
    return { created: 0 };
  }
}

/**
 * Start the generator: a catch-up tick shortly after boot, then every quarter
 * of an hour.
 * @returns {void}
 */
function startWorker() {
  setTimeout(tick, 45_000);
  setInterval(tick, POLL_INTERVAL_MS);
  console.log('Task recurrence worker started (every 15 minutes)');
}

module.exports = { startWorker, tick, generateOne };
