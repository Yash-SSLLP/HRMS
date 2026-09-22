/**
 * Templates, the directory, and repeating schedules.
 *
 * REWRITTEN 2026-09-21, replacing taskWorkflowController (485 lines, most of it
 * a workflow builder with publishing, versioning and a simulator). What is left
 * is the two things that were actually used: saving a task you will set again,
 * and managing the schedules that mint repeating ones.
 *
 * A TEMPLATE IS A TASK WITH THE DATES LEFT OFF (models/TaskTemplate). Nothing
 * is resolved or substituted; using one opens the assign form filled in.
 *
 * THE DIRECTORY is the same collection with `directory: true` — shared starter
 * templates grouped by department, so a new manager is not looking at an empty
 * page. Copying one gives you your own editable row and never touches the
 * original.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const TaskTemplate = require('../models/TaskTemplate');
const RecurringTask = require('../models/RecurringTask');
const Task = require('../models/Task');
const access = require('../services/taskAccess');
const recurrence = require('../services/taskRecurrenceWorker');
const {
  TASK_PRIORITY, DEFAULT_PRIORITY, normalisePriority, MAX_TASK_POINTS, FREQUENCIES, FREQUENCY,
} = require('../config/tasks');
const {
  cleanReminders, cleanRepeat, cleanLinks, personName,
} = require('./taskController');

function bad(res, message, status = 400) {
  res.status(status);
  throw new Error(message);
}

/** The template fields a body may set, cleaned. Shared by create and update. */
function templateFields(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.title !== undefined) out.title = String(body.title).trim();
  if (body.description !== undefined) out.description = String(body.description).trim();
  if (body.category !== undefined) out.category = String(body.category).trim();
  // Normalised, not whitelisted: a template saved before 2026-09-22 carries
  // `High`, and silently dropping it would quietly demote every urgent template.
  if (body.priority !== undefined) {
    const p = normalisePriority(body.priority);
    if (p) out.priority = p;
  }
  if (body.points !== undefined) {
    const p = Number(body.points);
    if (Number.isFinite(p) && p >= 0) out.points = Math.min(MAX_TASK_POINTS, Math.round(p));
  }
  if (body.dueInDays !== undefined) {
    const d = Number(body.dueInDays);
    out.dueInDays = Number.isFinite(d) && d >= 0 ? Math.round(d) : undefined;
  }
  if (body.repeat !== undefined) out.repeat = cleanRepeat(body.repeat);
  if (body.reminders !== undefined) out.reminders = cleanReminders(body.reminders);
  if (body.links !== undefined) out.links = cleanLinks(body.links);
  if (body.defaultAssignees !== undefined) {
    out.defaultAssignees = (body.defaultAssignees || [])
      .map(String).filter(mongoose.Types.ObjectId.isValid);
  }
  if (body.defaultLoopUsers !== undefined) {
    out.defaultLoopUsers = (body.defaultLoopUsers || [])
      .map(String).filter(mongoose.Types.ObjectId.isValid);
  }
  return out;
}

// ===== Templates =====

/**
 * GET /api/tasks/templates — mine, plus the shared directory.
 *
 * Both lists in one response because the page shows them as two tabs and a
 * second round trip to fill the other one is a second round trip for nothing.
 */
const listTemplates = asyncHandler(async (req, res) => {
  const companyOr = req.user.company
    ? [{ company: req.user.company }, { company: null }]
    : [{ company: null }, { company: { $exists: true } }];

  const [mine, directory] = await Promise.all([
    TaskTemplate.find({ owner: req.user._id, directory: { $ne: true }, isActive: true })
      .sort({ lastUsedAt: -1, name: 1 })
      .lean(),
    TaskTemplate.find({ directory: true, isActive: true, $or: companyOr })
      .sort({ department: 1, name: 1 })
      .lean(),
  ]);

  // The directory is presented grouped, which is how the page draws it and how
  // somebody actually browses it — by department, then by industry.
  const byDepartment = {};
  for (const t of directory) {
    const key = t.department || 'General';
    (byDepartment[key] ||= []).push(t);
  }

  res.json({
    templates: mine,
    directory,
    departments: Object.entries(byDepartment)
      .map(([name, items]) => ({ name, count: items.length, items }))
      .sort((a, b) => b.count - a.count),
    industries: [...new Set(directory.map((t) => t.industry).filter(Boolean))].sort(),
  });
});

/** POST /api/tasks/templates — save one, from scratch or from a task. */
const createTemplate = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // "Create template" on a task row: copy the task rather than retype it.
  if (body.fromTask) {
    if (!access.isValidId(body.fromTask)) bad(res, 'That task no longer exists.', 404);
    const task = await Task.findById(body.fromTask).lean();
    if (!task) bad(res, 'That task no longer exists.', 404);
    access.assertCanSee(req.user, task);

    const tpl = await TaskTemplate.create({
      name: String(body.name || task.title).trim().slice(0, 200),
      title: task.title,
      description: task.description,
      category: task.category,
      priority: task.priority,
      points: task.points,
      repeat: task.repeat,
      reminders: task.reminders,
      links: task.links,
      defaultAssignees: (task.assignees || []).map((a) => a.user),
      defaultLoopUsers: task.loopUsers,
      company: req.user.company || null,
      owner: req.user._id,
      createdBy: req.user._id,
      createdByName: personName(req.user),
    });
    return res.status(201).json({ template: tpl });
  }

  const fields = templateFields(body);
  if (!fields.title) bad(res, 'Give the template a task title.');
  if (!fields.name) fields.name = fields.title;

  const tpl = await TaskTemplate.create({
    ...fields,
    priority: fields.priority || DEFAULT_PRIORITY,
    company: req.user.company || null,
    owner: req.user._id,
    createdBy: req.user._id,
    createdByName: personName(req.user),
  });
  res.status(201).json({ template: tpl });
});

/** POST /api/tasks/templates/:id/copy — take a directory entry as your own. */
const copyTemplate = asyncHandler(async (req, res) => {
  const src = await TaskTemplate.findById(req.params.id).lean();
  if (!src) bad(res, 'That template is gone.', 404);

  const { _id, createdAt, updatedAt, useCount, lastUsedAt, ...rest } = src;
  const tpl = await TaskTemplate.create({
    ...rest,
    // Your own copy, never the shared original — see the docblock.
    directory: false,
    department: undefined,
    industry: undefined,
    company: req.user.company || null,
    owner: req.user._id,
    createdBy: req.user._id,
    createdByName: personName(req.user),
    useCount: 0,
    lastUsedAt: undefined,
  });
  res.status(201).json({ template: tpl });
});

/** PATCH /api/tasks/templates/:id — yours only. */
const updateTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) bad(res, 'That template is gone.', 404);
  if (String(tpl.owner || '') !== String(req.user._id) && !access.seesEverything(req.user)) {
    bad(res, 'That template is not yours to change.', 403);
  }
  Object.assign(tpl, templateFields(req.body || {}));
  await tpl.save();
  res.json({ template: tpl });
});

/** DELETE /api/tasks/templates/:id */
const deleteTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) bad(res, 'That template is already gone.', 404);
  if (String(tpl.owner || '') !== String(req.user._id) && !access.seesEverything(req.user)) {
    bad(res, 'That template is not yours to remove.', 403);
  }
  tpl.isActive = false;
  await tpl.save();
  res.json({ ok: true });
});

/**
 * GET /api/tasks/templates/:id/prefill — the assign form's starting values.
 *
 * Returns a task-shaped object rather than the template, so the form can drop
 * it straight into its state. `dueDate` is computed from `dueInDays` HERE
 * because the server owns what "three days from now" means — a phone in another
 * timezone would otherwise pick a different day.
 */
const prefillFromTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id).lean();
  if (!tpl) bad(res, 'That template is gone.', 404);

  let dueDate;
  if (Number.isFinite(tpl.dueInDays)) {
    const d = new Date();
    d.setDate(d.getDate() + tpl.dueInDays);
    d.setHours(18, 0, 0, 0);
    dueDate = d;
  }

  await TaskTemplate.updateOne(
    { _id: tpl._id },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } }
  );

  res.json({
    prefill: {
      title: tpl.title,
      description: tpl.description || '',
      category: tpl.category || '',
      priority: tpl.priority || DEFAULT_PRIORITY,
      points: tpl.points,
      dueDate,
      repeat: tpl.repeat || { frequency: FREQUENCY.ONCE },
      reminders: tpl.reminders || [],
      links: tpl.links || [],
      assignees: (tpl.defaultAssignees || []).map(String),
      loopUsers: (tpl.defaultLoopUsers || []).map(String),
      template: String(tpl._id),
    },
  });
});

// ===== Repeating schedules =====

/**
 * GET /api/tasks/recurring — the schedules, with what each one has produced.
 *
 * You see your own; `tasks.manage` sees the company's. A schedule is standing
 * configuration somebody set, and the person who set it is the one who needs to
 * find it again.
 */
const listRecurring = asyncHandler(async (req, res) => {
  const filter = access.seesEverything(req.user)
    ? (req.user.company ? { $or: [{ company: req.user.company }, { company: null }] } : {})
    : { createdBy: req.user._id };

  const schedules = await RecurringTask.find(filter)
    .populate('assignees', 'firstName lastName')
    .sort({ isActive: -1, createdAt: -1 })
    .lean();

  res.json({
    schedules: schedules.map((s) => ({
      ...s,
      // What the next one will be due, so a list can say it without the reader
      // having to work out what "weekly on Fri" means from today.
      nextDueDate: s.isActive ? recurrence.firstDueDate({ ...s, startDate: new Date() }) : null,
      who: (s.assignees || []).map((u) => [u.firstName, u.lastName].filter(Boolean).join(' ')).join(', '),
    })),
  });
});

/** PATCH /api/tasks/recurring/:id — pause it, resume it, or move its terms. */
const updateRecurring = asyncHandler(async (req, res) => {
  const schedule = await RecurringTask.findById(req.params.id);
  if (!schedule) bad(res, 'That schedule is gone.', 404);
  if (String(schedule.createdBy || '') !== String(req.user._id) && !access.seesEverything(req.user)) {
    bad(res, 'That schedule is not yours to change.', 403);
  }

  const b = req.body || {};
  if (b.isActive !== undefined) schedule.isActive = Boolean(b.isActive);
  if (b.title !== undefined) schedule.title = String(b.title).trim();
  if (b.description !== undefined) schedule.description = String(b.description).trim();
  if (b.category !== undefined) schedule.category = String(b.category).trim();
  if (b.priority !== undefined) {
    const p = normalisePriority(b.priority);
    if (p) schedule.priority = p;
  }
  if (b.points !== undefined) {
    const p = Number(b.points);
    if (Number.isFinite(p) && p >= 0) schedule.points = Math.min(MAX_TASK_POINTS, Math.round(p));
  }
  if (b.assignees !== undefined) {
    const ids = (b.assignees || []).map(String).filter(mongoose.Types.ObjectId.isValid);
    if (!ids.length) bad(res, 'A schedule needs at least one person on it.');
    // The direction rule applies here exactly as it does on a one-off: a
    // schedule must not be a way to set recurring work on your own manager.
    await access.resolveAssignmentKind(req.user, ids);
    schedule.assignees = ids;
  }
  if (b.loopUsers !== undefined) {
    schedule.loopUsers = (b.loopUsers || []).map(String).filter(mongoose.Types.ObjectId.isValid);
  }
  if (b.reminders !== undefined) schedule.reminders = cleanReminders(b.reminders);
  if (b.frequency !== undefined && FREQUENCIES.includes(b.frequency)) schedule.frequency = b.frequency;
  if (b.weekdays !== undefined) {
    schedule.weekdays = (b.weekdays || []).map(Number)
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  }
  if (b.monthDay !== undefined) schedule.monthDay = Number(b.monthDay) || undefined;
  if (b.month !== undefined) schedule.month = Number(b.month) || undefined;
  if (b.time !== undefined && /^\d{1,2}:\d{2}$/.test(String(b.time))) schedule.time = b.time;
  if (b.until !== undefined) {
    const u = b.until ? new Date(b.until) : null;
    schedule.until = u && !Number.isNaN(u.getTime()) ? u : undefined;
  }

  await schedule.save();
  res.json({ schedule });
});

/** DELETE /api/tasks/recurring/:id — stop it. Past occurrences stay. */
const deleteRecurring = asyncHandler(async (req, res) => {
  const schedule = await RecurringTask.findById(req.params.id);
  if (!schedule) bad(res, 'That schedule is already gone.', 404);
  if (String(schedule.createdBy || '') !== String(req.user._id) && !access.seesEverything(req.user)) {
    bad(res, 'That schedule is not yours to remove.', 403);
  }
  // Switched off rather than deleted: the tasks it already raised point at it,
  // and a dangling reference is how a list row loses its "Weekly" label.
  schedule.isActive = false;
  await schedule.save();
  res.json({ ok: true });
});

/** POST /api/tasks/recurring/:id/run — mint the next one now, for testing. */
const runRecurringNow = asyncHandler(async (req, res) => {
  const schedule = await RecurringTask.findById(req.params.id).lean();
  if (!schedule) bad(res, 'That schedule is gone.', 404);
  if (String(schedule.createdBy || '') !== String(req.user._id) && !access.seesEverything(req.user)) {
    bad(res, 'That schedule is not yours to run.', 403);
  }
  const made = await recurrence.runSchedule(schedule);
  res.json({ raised: made.length, tasks: made.map((t) => ({ _id: t._id, code: t.code, dueDate: t.dueDate })) });
});

module.exports = {
  listTemplates,
  createTemplate,
  copyTemplate,
  updateTemplate,
  deleteTemplate,
  prefillFromTemplate,
  listRecurring,
  updateRecurring,
  deleteRecurring,
  runRecurringNow,
};
