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
const User = require('../models/User');
const access = require('../services/taskAccess');
const recurrence = require('../services/taskRecurrenceWorker');
const points = require('../services/taskPoints');
const {
  TASK_PRIORITY, DEFAULT_PRIORITY, normalisePriority, MAX_TASK_POINTS, FREQUENCIES, FREQUENCY,
  MONTHLY_MODE, MONTHLY_MODES, NTH_WEEKS, MAX_DAY_INTERVAL, DEFAULT_LEAD_DAYS, MAX_LEAD_DAYS,
  REMINDER_WHEN, patternLabel, reminderLabel, isRoutineFrequency, spellingsOf, STATUS, OPEN_STATUS,
} = require('../config/tasks');
const {
  cleanReminders, cleanRepeat, cleanLinks, personName, parseBody, buildAssignees, storeVoiceNote,
} = require('./taskController');
const { departedUserIdSet } = require('../utils/departed');
const { pickableUserFilter } = require('../utils/peoplePicker');
const { viewerCompanyScope } = require('../utils/employeeScope');

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

  // A template saved months ago can still name somebody who has since left.
  // This is a NEW task, so they are simply not on it — the picker would never
  // have offered them, and a prefill must not slip one past it.
  const gone = await departedUserIdSet([...(tpl.defaultAssignees || []), ...(tpl.defaultLoopUsers || [])]);
  const here = (ids) => (ids || []).map(String).filter((id) => !gone.has(id));

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
      assignees: here(tpl.defaultAssignees),
      loopUsers: here(tpl.defaultLoopUsers),
      template: String(tpl._id),
    },
  });
});

// ===== Repeating schedules =====
//
// REWORKED 2026-09-27 into the RECURRING TAB — the user's *"need a separate
// tab for recurring tasks, only to assign; after assigned it will show them in
// their task tab"*. A schedule is set up on its own here, and nothing is
// raised until an occurrence is due to APPEAR (services/taskRecurrenceWorker):
// a daily task at 9 am on its day, a monthly one two days early. Each
// occurrence is an ordinary task in the doer's Tasks list.

const IST_DAY = (key) => new Date(`${key}T00:00:00+05:30`);

/** 'YYYY-MM-DD' (or an ISO instant) → IST midnight of that day, or null. */
function dayOf(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return IST_DAY(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return IST_DAY(recurrence.occurrenceKeyFor(d));
}

const validTime = (t) => /^\d{1,2}:\d{2}$/.test(String(t || ''));

/**
 * The schedule fields a body may set, cleaned — shared by create and update.
 * Accepts them flat or under `repeat` (the shape the assign form already sends).
 * Returns only what was SENT, so a PATCH changes only what it names.
 */
function scheduleFields(body) {
  const src = { ...(body.repeat && typeof body.repeat === 'object' ? body.repeat : {}), ...body };
  const out = {};
  if (src.frequency !== undefined) {
    if (!FREQUENCIES.includes(src.frequency) || src.frequency === FREQUENCY.ONCE) {
      const err = new Error('Choose how often it repeats — daily, weekly, monthly or yearly.');
      err.status = 400;
      throw err;
    }
    out.frequency = src.frequency;
  }
  if (src.interval !== undefined) {
    const n = Math.round(Number(src.interval) || 1);
    out.interval = Math.min(MAX_DAY_INTERVAL, Math.max(1, n));
  }
  if (src.weekdays !== undefined) {
    out.weekdays = [...new Set((Array.isArray(src.weekdays) ? src.weekdays : [])
      .map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  }
  if (src.monthlyMode !== undefined) {
    out.monthlyMode = MONTHLY_MODES.includes(src.monthlyMode) ? src.monthlyMode : MONTHLY_MODE.DATE;
  }
  if (src.nthWeek !== undefined) {
    const n = Number(src.nthWeek);
    out.nthWeek = NTH_WEEKS.includes(n) ? n : 1;
  }
  if (src.weekday !== undefined) {
    const w = Number(src.weekday);
    out.weekday = Number.isInteger(w) && w >= 0 && w <= 6 ? w : 1;
  }
  if (src.monthDay !== undefined) {
    const d = Number(src.monthDay);
    out.monthDay = Number.isInteger(d) && d >= 1 && d <= 31 ? d : undefined;
  }
  if (src.month !== undefined) {
    const m = Number(src.month);
    out.month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : undefined;
  }
  if (src.time !== undefined && validTime(src.time)) {
    const [h, m] = String(src.time).split(':').map((n) => parseInt(n, 10));
    out.time = `${String(Math.min(23, h)).padStart(2, '0')}:${String(Math.min(59, m)).padStart(2, '0')}`;
  }
  if (src.startDate !== undefined) out.startDate = dayOf(src.startDate) || undefined;
  if (src.until !== undefined) out.until = src.until ? dayOf(src.until) : null;
  if (src.leadDays !== undefined && src.leadDays !== null && src.leadDays !== '') {
    const n = Math.round(Number(src.leadDays));
    if (Number.isFinite(n)) out.leadDays = Math.min(MAX_LEAD_DAYS, Math.max(0, n));
  }
  return out;
}

/** The pattern must say WHICH days, or it would never fire. */
function assertShape(s) {
  const fail = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (s.frequency === FREQUENCY.WEEKLY && !(s.weekdays || []).length) fail('Pick at least one day of the week.');
  if (s.until && s.startDate && new Date(s.until) < new Date(s.startDate)) {
    fail('The end date is before the start date.');
  }
}

/**
 * One schedule as both clients draw it: the pattern in words, when the next
 * one is due and when it will appear, who it is for, and what it has produced.
 */
function present(s, stats = {}, gone = new Set()) {
  const assignees = (s.assignees || []).filter((u) => u && !gone.has(String(u._id || u)));
  // Past the days already raised: today's daily task appeared at nine and may
  // be done by now — "Next due today, 7 PM" beside it read as if it were not.
  const next = s.isActive
    ? recurrence.nextOccurrence(s, new Date(), { skipKeys: stats.upcoming || null })
    : null;
  return {
    ...s,
    assignees,
    routine: isRoutineFrequency(s.frequency),
    leadDays: recurrence.leadDaysOf(s),
    patternLabel: patternLabel(s),
    // An email reminder says so — "1 day after (email)" — the rest are app pushes.
    reminderLabels: (s.reminders || []).map((r) => `${reminderLabel(r)}${r.channel === 'EMAIL' ? ' (email)' : ''}`),
    next: next ? { dueAt: next.dueAt, appearAt: next.appearAt } : null,
    // Kept under its old name: an app build from before the tab reads it.
    nextDueDate: next ? next.dueAt : null,
    who: assignees.map((u) => personName(u)).filter(Boolean).join(', '),
    stats: {
      raised: stats.raised || 0,
      open: stats.open || 0,
      done: stats.done || 0,
      last: stats.last || null,
    },
  };
}

/** What each schedule has produced, for a page of them, in ONE aggregation. */
async function statsFor(ids) {
  if (!ids.length) return new Map();
  const open = spellingsOf(...OPEN_STATUS);
  const done = spellingsOf(STATUS.COMPLETED);
  const rows = await Task.aggregate([
    { $match: { recurringTask: { $in: ids }, archived: { $ne: true } } },
    { $sort: { dueDate: -1 } },
    {
      $group: {
        _id: '$recurringTask',
        raised: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', open] }, 1, 0] } },
        done: { $sum: { $cond: [{ $in: ['$status', done] }, 1, 0] } },
        last: { $first: { _id: '$_id', code: '$code', status: '$status', dueDate: '$dueDate' } },
      },
    },
  ]);
  const out = new Map(rows.map((r) => [String(r._id), { ...r, upcoming: new Set() }]));

  // The days from today on that already have their task (a handful at most —
  // the lead is ≤ 14 days), so present() can say which one is NEXT. Archived
  // ones count: the unique key still stops that day being raised again.
  const raised = await Task.find({
    recurringTask: { $in: ids },
    occurrenceKey: { $gte: recurrence.occurrenceKeyFor(new Date()) },
  }).select('recurringTask occurrenceKey').lean();
  for (const t of raised) {
    const id = String(t.recurringTask);
    if (!out.has(id)) out.set(id, { upcoming: new Set() });
    out.get(id).upcoming.add(t.occurrenceKey);
  }
  return out;
}

/** Whose schedules this caller may see and change. */
function mayManage(user, schedule) {
  return String(schedule.createdBy || '') === String(user._id) || access.seesEverything(user);
}

/**
 * GET /api/tasks/recurring — the schedules, with what each one has produced.
 *
 * You see your own; `tasks.manage` sees the company's. A schedule is standing
 * configuration somebody set, and the person who set it is the one who needs to
 * find it again.
 */
const listRecurring = asyncHandler(async (req, res) => {
  const filter = access.seesEverything(req.user) && req.query.scope !== 'mine'
    ? (req.user.company ? { $or: [{ company: req.user.company }, { company: null }] } : {})
    : { createdBy: req.user._id };

  const schedules = await RecurringTask.find(filter)
    .populate('assignees', 'firstName lastName photo')
    .populate('loopUsers', 'firstName lastName')
    .sort({ isActive: -1, createdAt: -1 })
    .lean();

  // Somebody who has left is on no schedule any more — the worker already
  // skips them when it raises each task — so the list does not name them
  // either. A schedule left with nobody on it reads as exactly that.
  const gone = await departedUserIdSet(schedules.flatMap((s) => (s.assignees || []).map((u) => u?._id)));
  const stats = await statsFor(schedules.map((s) => s._id));

  res.json({
    schedules: schedules.map((s) => present(s, stats.get(String(s._id)), gone)),
    canSeeAll: access.seesEverything(req.user),
  });
});

/** GET /api/tasks/recurring/:id — one schedule, for the edit form. */
const getRecurring = asyncHandler(async (req, res) => {
  if (!access.isValidId(req.params.id)) bad(res, 'That schedule is gone.', 404);
  const schedule = await RecurringTask.findById(req.params.id)
    .populate('assignees', 'firstName lastName photo')
    .populate('loopUsers', 'firstName lastName')
    .lean();
  if (!schedule) bad(res, 'That schedule is gone.', 404);
  if (!mayManage(req.user, schedule)) bad(res, 'That schedule is not yours to open.', 403);
  const stats = await statsFor([schedule._id]);
  res.json({ schedule: present(schedule, stats.get(String(schedule._id))) });
});

/**
 * POST /api/tasks/recurring — set one up.
 *
 * Only the SCHEDULE is made. Whatever is already due to appear (today's daily
 * task, set up at eleven for six o'clock) is raised at once; everything else
 * appears when its day comes. `mintFrom` = now, so an occurrence whose time has
 * already passed today is never raised overdue — it starts next time.
 */
const createRecurring = asyncHandler(async (req, res) => {
  const body = parseBody(req);
  const title = String(body.title || '').trim();
  if (!title) bad(res, 'Give the task a title.');

  // On somebody else's behalf — the same rule, and the same check, as a one-off
  // (taskController.createTask): the grant, and the company wall.
  let setter = req.user;
  let proxy = null;
  const behalfId = String(body.onBehalfOf || '').trim();
  if (behalfId && behalfId !== String(req.user._id)) {
    if (!access.canAssignOnBehalf(req.user)) {
      bad(res, 'Setting a task on somebody else’s behalf needs a permission only a Super Admin can give.', 403);
    }
    if (!mongoose.Types.ObjectId.isValid(behalfId)) bad(res, 'Choose who the task is being set for.');
    const principal = await User.findOne({ $and: [await pickableUserFilter(req), { _id: behalfId }] })
      .select('firstName lastName role company');
    if (!principal) bad(res, 'You cannot set a task for that person — they are not in your company, or no longer active.');
    setter = principal;
    proxy = { by: req.user._id, byName: personName(req.user), at: new Date() };
  }

  let wanted = (body.assignees || []).map(String).filter(Boolean);
  // Nobody chosen means the setter's own routine — "remind me every Friday".
  if (!wanted.length) wanted = [String(setter._id)];
  await access.resolveAssignmentKind(setter, wanted);
  const people = await buildAssignees(wanted);
  if (!people.length) bad(res, 'None of the people chosen are available any more.');
  const selfOnly = people.every((p) => String(p.user) === String(setter._id));

  const shape = scheduleFields(body);
  if (!shape.frequency) bad(res, 'Choose how often it repeats — daily, weekly, monthly or yearly.');
  if (!shape.startDate) shape.startDate = dayOf(new Date());
  if (shape.frequency === FREQUENCY.WEEKLY && !(shape.weekdays || []).length) {
    shape.weekdays = [new Date(shape.startDate.getTime() + 6 * 3600 * 1000).getUTCDay()];
  }
  assertShape(shape);

  const settings = await points.taskSettings();
  let pts = body.points === undefined || body.points === null || body.points === ''
    ? settings.defaultPoints : Number(body.points);
  if (!Number.isFinite(pts) || pts < 0) bad(res, 'Points must be a number, 0 or more.');
  pts = Math.min(MAX_TASK_POINTS, Math.round(pts));

  // A daily task is chased every two hours until done unless the form says
  // otherwise — the user's own example.
  const reminders = body.reminders !== undefined
    ? cleanReminders(body.reminders)
    : (isRoutineFrequency(shape.frequency)
      ? [{ channel: 'APP', amount: 2, unit: 'HOURS', when: REMINDER_WHEN.EVERY }]
      : settings.defaultReminders);

  const companyScope = await viewerCompanyScope(req);
  const schedule = await RecurringTask.create({
    title,
    description: String(body.description || '').trim(),
    category: String(body.category || '').trim(),
    priority: normalisePriority(body.priority) || DEFAULT_PRIORITY,
    points: selfOnly ? 0 : pts,
    assignees: people.map((p) => p.user),
    loopUsers: [...new Set((body.loopUsers || []).map(String))].filter(mongoose.Types.ObjectId.isValid),
    links: cleanLinks(body.links),
    reminders,
    requiresApproval: !(body.requiresApproval === false
      || body.requiresApproval === 'false' || body.requiresApproval === '0'),
    time: '18:00',
    ...shape,
    mintFrom: new Date(),
    isActive: true,
    company: setter.company || req.user.company || companyScope?.[0] || null,
    createdBy: setter._id,
    createdByName: personName(setter),
    ...(proxy ? { onBehalf: proxy } : {}),
  });

  // The recording, explained once and copied onto every occurrence.
  const voice = await storeVoiceNote(req.files, schedule._id, req.user, body.voiceDurationMs);
  if (voice) {
    schedule.voiceNote = voice;
    await schedule.save();
  }

  const made = await recurrence.runSchedule(schedule.toObject(), new Date());
  const fresh = await RecurringTask.findById(schedule._id)
    .populate('assignees', 'firstName lastName photo')
    .populate('loopUsers', 'firstName lastName')
    .lean();
  const out = present(fresh, {
    raised: made.length,
    open: made.length,
    upcoming: new Set(made.map((t) => t.occurrenceKey)),
  });
  res.status(201).json({
    schedule: out,
    raised: made.length,
    message: made.length
      ? `Set up. The first one is on ${out.who || 'their'} list now.`
      : (out.next
        ? `Set up. The first one appears on ${new Date(out.next.appearAt).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
        })}.`
        : 'Set up.'),
  });
});

/**
 * PATCH /api/tasks/recurring/:id — pause it, resume it, or move its terms.
 *
 * The OCCURRENCES ALREADY RAISED keep the terms they were raised with; this
 * changes what is raised from now on. Changing WHEN it repeats, or switching it
 * back on, moves `mintFrom` to now — without that, turning a Monday task into a
 * daily one on a Thursday would raise Tuesday's and Wednesday's, overdue, in the
 * catch-up.
 */
const updateRecurring = asyncHandler(async (req, res) => {
  if (!access.isValidId(req.params.id)) bad(res, 'That schedule is gone.', 404);
  const schedule = await RecurringTask.findById(req.params.id);
  if (!schedule) bad(res, 'That schedule is gone.', 404);
  if (!mayManage(req.user, schedule)) bad(res, 'That schedule is not yours to change.', 403);

  const b = parseBody(req);
  const now = new Date();
  let reshaped = false;

  if (b.isActive !== undefined) {
    const on = b.isActive === true || b.isActive === 'true' || b.isActive === '1';
    if (on && !schedule.isActive) schedule.mintFrom = now;
    schedule.isActive = on;
  }
  if (b.title !== undefined) {
    const t = String(b.title).trim();
    if (!t) bad(res, 'A task needs a title.');
    schedule.title = t;
  }
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
  if (b.requiresApproval !== undefined) {
    schedule.requiresApproval = !(b.requiresApproval === false
      || b.requiresApproval === 'false' || b.requiresApproval === '0');
  }
  if (b.assignees !== undefined) {
    const ids = (b.assignees || []).map(String).filter(mongoose.Types.ObjectId.isValid);
    if (!ids.length) bad(res, 'A schedule needs at least one person on it.');
    await access.resolveAssignmentKind(req.user, ids);
    schedule.assignees = ids;
  }
  if (b.loopUsers !== undefined) {
    schedule.loopUsers = (b.loopUsers || []).map(String).filter(mongoose.Types.ObjectId.isValid);
  }
  if (b.reminders !== undefined) schedule.reminders = cleanReminders(b.reminders);
  if (b.links !== undefined) schedule.links = cleanLinks(b.links);

  const shape = scheduleFields(b);
  const SHAPE_KEYS = ['frequency', 'interval', 'weekdays', 'monthlyMode', 'nthWeek', 'weekday',
    'monthDay', 'month', 'time', 'startDate', 'leadDays'];
  for (const [k, v] of Object.entries(shape)) {
    const was = schedule[k];
    const same = Array.isArray(v)
      ? JSON.stringify([...(was || [])]) === JSON.stringify(v)
      : String(was ?? '') === String(v ?? '');
    if (!same && SHAPE_KEYS.includes(k)) reshaped = true;
    schedule[k] = v === null ? undefined : v;
  }
  // A frequency change resets the lead to that shape's default unless sent.
  if (shape.frequency && shape.leadDays === undefined && reshaped) {
    schedule.leadDays = DEFAULT_LEAD_DAYS[shape.frequency] ?? 0;
  }
  assertShape(schedule);
  if (reshaped) schedule.mintFrom = now;

  const voice = await storeVoiceNote(req.files, schedule._id, req.user, b.voiceDurationMs);
  if (voice) schedule.voiceNote = voice;

  await schedule.save();

  // Something may now be due to appear (switched on, or moved to today).
  if (schedule.isActive) {
    await recurrence.runSchedule(schedule.toObject(), now).catch((e) => console.error('recurring run failed:', e.message));
  }

  const fresh = await RecurringTask.findById(schedule._id)
    .populate('assignees', 'firstName lastName photo')
    .populate('loopUsers', 'firstName lastName')
    .lean();
  const stats = await statsFor([schedule._id]);
  res.json({ schedule: present(fresh, stats.get(String(schedule._id))) });
});

/** DELETE /api/tasks/recurring/:id — stop it. Past occurrences stay. */
const deleteRecurring = asyncHandler(async (req, res) => {
  const schedule = await RecurringTask.findById(req.params.id);
  if (!schedule) bad(res, 'That schedule is already gone.', 404);
  if (!mayManage(req.user, schedule)) bad(res, 'That schedule is not yours to remove.', 403);
  // Switched off rather than deleted: the tasks it already raised point at it,
  // and a dangling reference is how a list row loses its "Weekly" label.
  schedule.isActive = false;
  await schedule.save();
  res.json({ ok: true });
});

/** POST /api/tasks/recurring/:id/run — raise whatever is due to appear now. */
const runRecurringNow = asyncHandler(async (req, res) => {
  const schedule = await RecurringTask.findById(req.params.id).lean();
  if (!schedule) bad(res, 'That schedule is gone.', 404);
  if (!mayManage(req.user, schedule)) bad(res, 'That schedule is not yours to run.', 403);
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
  getRecurring,
  createRecurring,
  updateRecurring,
  deleteRecurring,
  runRecurringNow,
};
