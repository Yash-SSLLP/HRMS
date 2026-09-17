/**
 * HRMS events that create tasks (section 31).
 *
 * Somebody joins and the onboarding work has to happen; somebody resigns and the
 * exit work has to happen; somebody is confirmed, promoted or transferred and a
 * handful of records have to be brought into line. All of that was already a
 * checklist somebody kept in their head — this is the same checklist, kept by
 * the module, with a name against every line and a deadline on it.
 *
 * NOTHING IS HARD-CODED. An event does not describe the work; it names a
 * TRIGGER, and whatever active templates carry that trigger produce the tasks.
 * So HR changes what happens on a new joiner by editing a template, not by
 * asking for a code change — which is the whole point of section 24 and the
 * reason this file is sixty lines rather than six hundred.
 *
 * IT CAN NEVER BREAK THE THING THAT CAUSED IT. Every entry point swallows its
 * own errors and is fired without being awaited. A resignation must be accepted
 * even if the exit tasks cannot be made; an employee must be created even if
 * onboarding cannot. What fails is logged loudly and can be re-run from the
 * template by hand.
 *
 * IT CANNOT FIRE TWICE for the same event. Each generated task carries a
 * `recurringTask`-style key of its own — `occurrenceKey` set to
 * `<trigger>:<subject>` — and Task's unique index on (recurringTask,
 * occurrenceKey) does not cover it, so the guard here is an explicit lookup.
 * That is enough: these events are raised once per request, not by a worker that
 * can replay.
 */
const Task = require('../models/Task');
const TaskTemplate = require('../models/TaskTemplate');
const EmployeeProfile = require('../models/EmployeeProfile');
const { buildTaskFromTemplate } = require('./taskTemplates');
const flow = require('./taskWorkflow');
const engine = require('./taskEngine');
const notify = require('./taskNotify');

/**
 * The events a template may be wired to. Kept as a list so the template form can
 * offer them and so a typo in a template is visible rather than silent.
 */
const TRIGGERS = [
  { key: 'employee.created', label: 'A new employee is created', hint: 'Onboarding' },
  { key: 'employee.confirmed', label: 'Probation is confirmed', hint: 'Confirmation paperwork' },
  { key: 'employee.transferred', label: 'An employee changes department', hint: 'Handover and asset transfer' },
  { key: 'employee.promoted', label: 'A salary or designation revision is applied', hint: 'HRIS, payroll and the letter' },
  { key: 'exit.approved', label: 'A resignation is accepted', hint: 'Asset recovery, IT access, clearance' },
  { key: 'exit.completed', label: 'An exit is finalised', hint: 'Settlement, experience letter' },
];

const TRIGGER_KEYS = TRIGGERS.map((t) => t.key);

/**
 * Raise an event: build a task from every active template wired to it.
 *
 * @param {string} trigger - one of TRIGGER_KEYS
 * @param {object} ctx
 * @param {*} ctx.subject - the User the tasks are ABOUT (the joiner, the leaver)
 * @param {object} [ctx.actor] - who caused it, for the trail
 * @param {object} [ctx.vars] - extra placeholder values for the title
 * @param {*} [ctx.company]
 * @returns {Promise<Array>} the tasks created (empty when no template is wired)
 */
async function raise(trigger, ctx = {}) {
  const made = [];
  try {
    if (!TRIGGER_KEYS.includes(trigger)) {
      console.error(`Task event: "${trigger}" is not a known trigger.`);
      return made;
    }

    const templates = await TaskTemplate.find({ trigger, active: true });
    if (!templates.length) return made;

    for (const tpl of templates) {
      try {
        const task = await createFromTemplate(tpl, trigger, ctx);
        if (task) made.push(task);
      } catch (err) {
        console.error(`Task event ${trigger} / template "${tpl.name}" failed:`, err.message);
      }
    }

    if (made.length) {
      console.log(`Task event ${trigger}: created ${made.length} task(s)`);
    }
  } catch (err) {
    console.error(`Task event ${trigger} failed:`, err.message);
  }
  return made;
}

/**
 * One template, for one event.
 * @returns {Promise<object|null>} null when this event has already made it
 */
async function createFromTemplate(tpl, trigger, ctx) {
  const subjectId = ctx.subject && String(ctx.subject._id || ctx.subject);
  // The idempotence key. A create endpoint called twice — a double-tapped Save,
  // a retried request — must not produce two onboarding plans for one person.
  const key = `${trigger}:${subjectId || 'none'}:${tpl._id}`;

  const already = await Task.findOne({ occurrenceKey: key }).select('_id').lean();
  if (already) return null;

  const fields = await buildTaskFromTemplate(tpl, {
    actor: ctx.actor,
    subject: ctx.subject,
    vars: ctx.vars,
  });
  const { subtasks, workflow, ...taskFields } = fields;

  const task = new Task({
    ...taskFields,
    createdBy: ctx.actor ? ctx.actor._id : tpl.createdBy,
    company: taskFields.company || ctx.company,
    template: tpl._id,
    occurrenceKey: key,
  });

  if (workflow) {
    try {
      await flow.start(task, workflow);
    } catch (err) {
      // A workflow that cannot start must not stop the task existing — the work
      // still has to be done, and an unrouted task beats no task.
      console.error(`Task event: workflow could not start for "${tpl.name}" — ${err.message}`);
    }
  }

  await task.save();

  await engine.logActivity({
    task: task._id,
    kind: 'created',
    by: ctx.actor,
    system: !ctx.actor,
    message: `Created automatically — ${describeTrigger(trigger)}`,
    refModel: 'TaskTemplate',
    refId: tpl._id,
  });

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
      createdBy: task.createdBy,
    });
    await child.save();
  }
  if ((subtasks || []).length) await engine.recomputeRollups(task._id);

  if ((task.assignees || []).length) {
    notify.assigned(task, task.assignees.map((a) => a.user), ctx.actor || null).catch(() => {});
  }

  await TaskTemplate.updateOne({ _id: tpl._id }, { $inc: { usageCount: 1 } });

  return task;
}

const describeTrigger = (t) => (TRIGGERS.find((x) => x.key === t) || {}).label || t;

// ===== The entry points the rest of the app calls =====
//
// Each is a thin, named wrapper rather than callers passing raw trigger strings.
// A typo in a string is a silent no-op; a typo in a function name is a crash on
// the first run, which is the failure mode worth having.

/**
 * A new employee has been created. Raises `employee.created`.
 * @param {object} profile - the new EmployeeProfile
 * @param {object} [actor] - req.user
 */
function employeeCreated(profile, actor) {
  if (!profile || !profile.user) return Promise.resolve([]);
  return raise('employee.created', {
    subject: profile.user,
    actor,
    company: profile.company,
    vars: { department: profile.department, code: profile.employeeCode },
  });
}

/** Probation confirmed. */
function employeeConfirmed(profile, actor) {
  if (!profile || !profile.user) return Promise.resolve([]);
  return raise('employee.confirmed', {
    subject: profile.user, actor, company: profile.company,
    vars: { department: profile.department, code: profile.employeeCode },
  });
}

/**
 * A salary or designation revision has been applied.
 * @param {object} profile
 * @param {object} [actor]
 * @param {object} [details] - { from, to } designation, for the title
 */
function employeePromoted(profile, actor, details = {}) {
  if (!profile || !profile.user) return Promise.resolve([]);
  return raise('employee.promoted', {
    subject: profile.user, actor, company: profile.company,
    vars: { department: profile.department, code: profile.employeeCode, ...details },
  });
}

/** An employee has changed department. */
function employeeTransferred(profile, actor, details = {}) {
  if (!profile || !profile.user) return Promise.resolve([]);
  return raise('employee.transferred', {
    subject: profile.user, actor, company: profile.company,
    vars: { department: profile.department, code: profile.employeeCode, ...details },
  });
}

/**
 * A resignation has been accepted into the notice period. Raises
 * `exit.approved` — asset recovery, IT access removal, the exit interview,
 * clearance and settlement.
 *
 * The exit record carries an EmployeeProfile id, so the profile is loaded here
 * to find the person behind it; the caller has no reason to know that.
 * @param {object} exit - an ExitRequest
 * @param {object} [actor]
 */
async function exitApproved(exit, actor) {
  try {
    if (!exit || !exit.employee) return [];
    const profile = await EmployeeProfile.findById(exit.employee._id || exit.employee)
      .select('user department employeeCode company lastWorkingDay')
      .lean();
    if (!profile || !profile.user) return [];
    return await raise('exit.approved', {
      subject: profile.user,
      actor,
      company: profile.company,
      vars: {
        department: profile.department,
        code: profile.employeeCode,
        lastWorkingDay: exit.lastWorkingDay
          ? new Date(exit.lastWorkingDay).toLocaleDateString('en-IN', {
            day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
          })
          : '',
      },
    });
  } catch (err) {
    console.error('Task event exit.approved failed:', err.message);
    return [];
  }
}

/** An exit has been finalised. */
async function exitCompleted(exit, actor) {
  try {
    if (!exit || !exit.employee) return [];
    const profile = await EmployeeProfile.findById(exit.employee._id || exit.employee)
      .select('user department employeeCode company')
      .lean();
    if (!profile || !profile.user) return [];
    return await raise('exit.completed', {
      subject: profile.user, actor, company: profile.company,
      vars: { department: profile.department, code: profile.employeeCode },
    });
  } catch (err) {
    console.error('Task event exit.completed failed:', err.message);
    return [];
  }
}

module.exports = {
  TRIGGERS,
  TRIGGER_KEYS,
  raise,
  employeeCreated,
  employeeConfirmed,
  employeePromoted,
  employeeTransferred,
  exitApproved,
  exitCompleted,
};
