/**
 * Task controller — CRUD for Task documents plus employee self-service.
 * HR/Admin manage all tasks (assign to users, link to projects); employees
 * list and advance the status of tasks assigned to them only.
 *
 * Both directions of the module notify: handing somebody a task tells them they
 * have it, and the assignee moving it tells the person who handed it over. See
 * the "Notifications" section below — a task nobody was told about is a task
 * nobody does, and a status nobody hears about is one HR has to go and look for.
 */
const asyncHandler = require('express-async-handler');
const Task = require('../models/Task');
const { TASK_STATUS, TASK_PRIORITY } = require('../models/Task');
const User = require('../models/User');
const { scopeUserField } = require('../utils/employeeScope');
const { pickablePeople } = require('../utils/peoplePicker');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');

// Populated user sub-fields returned for assignedTo references
const USER_FIELDS = 'firstName lastName email role';

// ===== Notifications =====
// Where each side of the module lives, so a tapped alert lands on the page that
// can act on it. The employee link is resolved straight through by the web
// portal and by the app's PATH_SCREENS table; the admin one needs the app's
// ADMIN_PATH_SCREENS rule, or a suffix match on '/tasks' would open the HR
// user's OWN task list instead of the board the alert is about.
const EMPLOYEE_LINK = '/employee/tasks';
const ADMIN_LINK = '/admin/tasks';

// 'InProgress' is a schema value, not a sentence. Only this one needs spelling
// out; the other three read the same either way.
const STATUS_LABELS = { InProgress: 'In Progress' };
const statusLabel = (s) => STATUS_LABELS[s] || s;

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

/**
 * The one-line tail that turns a bare title into something actionable —
 * "· Urgent · due 12 Mar 2026". Both fields are optional on a task, so it is
 * built from whatever is actually set rather than printing empty labels.
 * @param {object} task
 * @returns {string} '' when the task carries neither
 */
function taskMeta(task) {
  const bits = [];
  if (task.priority && task.priority !== 'Medium') bits.push(task.priority);
  if (task.dueDate) bits.push(`due ${fmtDate(task.dueDate)}`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/**
 * Tell somebody a task is now theirs. Best-effort: a notification must never
 * fail the write that caused it, so every caller fires this without awaiting a
 * rejection.
 *
 * Nobody is notified of their own doing — an HR user who assigns a task to
 * themselves already knows, and the alert would just be their own click echoed
 * back at them.
 * @param {object} task - the saved Task
 * @param {*} actorId - who did the assigning
 * @param {string} [title='New task assigned']
 * @returns {Promise<void>}
 */
async function notifyAssigned(task, actorId, title = 'New task assigned') {
  if (!task.assignedTo || String(task.assignedTo) === String(actorId)) return;
  await notify({
    recipient: task.assignedTo,
    type: 'task',
    // 'employee': My Tasks is an employee-portal page, so a dual-role HRManager
    // reads this in My Portal rather than beside their admin alerts.
    audience: 'employee',
    title,
    body: `"${task.title}"${taskMeta(task)}`,
    link: EMPLOYEE_LINK,
  });
}

// The fields an assignee would want to hear about when a manager edits their
// task, paired with the word the notification uses for each. `assignedTo` is
// deliberately absent — a change of owner is a new assignment, not an edit, and
// is notified as one.
const WATCHED_FIELDS = [
  ['title', 'title'],
  ['description', 'description'],
  ['priority', 'priority'],
  ['dueDate', 'due date'],
  ['status', 'status'],
  ['project', 'project'],
];

/**
 * Whether two task field values are the same thing.
 *
 * The admin form PUTs the whole task on every save, so "what changed" can only
 * be answered by comparing against the pre-update document — and the values
 * arrive in three shapes: a Date vs an ISO string from a date input, an
 * ObjectId vs its hex string, and plain strings. Compared naively, every save
 * would look like a change and notify the assignee about nothing.
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (a == null && b == null) return true;
  if (a instanceof Date || b instanceof Date) {
    const ta = a ? new Date(a).getTime() : null;
    const tb = b ? new Date(b).getTime() : null;
    return ta === tb;
  }
  return String(a ?? '') === String(b ?? '');
}

/**
 * Tell the assignee their task was edited, naming what changed.
 * @param {object} task - the saved Task
 * @param {string[]} changed - human words for the changed fields
 * @param {*} actorId - who made the edit
 * @returns {Promise<void>}
 */
async function notifyTaskEdited(task, changed, actorId) {
  if (!task.assignedTo || !changed.length || String(task.assignedTo) === String(actorId)) return;
  await notify({
    recipient: task.assignedTo,
    type: 'task',
    audience: 'employee',
    title: 'Task updated',
    body: `"${task.title}" — ${changed.join(', ')} changed${taskMeta(task)}.`,
    link: EMPLOYEE_LINK,
  });
}

/**
 * Tell the other side that the assignee moved their own task.
 *
 * The ASSIGNER is the one person who definitely wants to know, so `createdBy`
 * is the recipient wherever there is one. Two cases fall back to the whole
 * `tasks.manage` bench instead — a task created before the field existed, and
 * one whose assigner has since left — because an orphaned task's progress
 * should still reach somebody rather than nobody. The fallback is walled to the
 * assignee's own company, so another company's HR never hears about their people.
 *
 * @param {object} task - the saved Task
 * @param {object} actor - req.user (the assignee doing the moving)
 * @param {string} from - status before
 * @param {string} to - status after
 * @returns {Promise<void>}
 */
async function notifyOwnerOfStatusChange(task, actor, from, to) {
  const creator = task.createdBy
    ? await User.findOne({ _id: task.createdBy, isActive: true }).select('_id').lean()
    : null;
  const recipients = creator
    ? [creator._id]
    : await scopeRecipientsToCompany(await usersHoldingAny('tasks.manage'), actor.scopeCompanyId);

  // Someone who assigned a task to themselves is both sides of this; they moved
  // it, so they do not need telling.
  const ids = recipients.filter((id) => String(id) !== String(actor._id));
  if (!ids.length) return;

  const who = `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || 'An employee';
  await notifyMany(ids, {
    type: 'task',
    // 'admin': the board this points at is an admin-portal page, and
    // `tasks.manage` is only ever held by an account that has one.
    audience: 'admin',
    title: to === 'Done' ? 'Task completed' : 'Task moved by assignee',
    body: `${who} moved "${task.title}" from ${statusLabel(from)} to ${statusLabel(to)}.`,
    link: ADMIN_LINK,
  });
}

// ===== HR/Admin =====
/**
 * List all tasks with optional filters, newest first.
 * @route GET /api/tasks
 * @param {string} [req.query.project] - filter by project id
 * @param {string} [req.query.assignedTo] - filter by assignee id
 * @param {string} [req.query.status] - filter by task status
 * @returns {{count: number, tasks: Object[]}} tasks with populated assignee/project
 */
const listTasks = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
  if (req.query.status) filter.status = req.query.status;
  // Company wall: walled admins only see tasks assigned to people of their own
  // company (Task.assignedTo is a User id).
  await scopeUserField(req, filter, 'assignedTo');
  // Unassigned tasks carry no people-data, so keep them visible to walled
  // viewers too — unless a specific assignee was asked for above.
  if (!req.query.assignedTo && filter.assignedTo && Array.isArray(filter.assignedTo.$in)) {
    filter.assignedTo.$in.push(null);
  }
  const tasks = await Task.find(filter)
    .populate('assignedTo', USER_FIELDS)
    .populate('project', 'name status')
    .sort({ createdAt: -1 });
  res.json({ count: tasks.length, tasks });
});

/**
 * Create a task. Records the creating user as createdBy.
 * @route POST /api/tasks
 * @param {string} req.body.title - required task title
 * @param {Object} req.body - other task fields (project, assignedTo, status, priority, dueDate)
 * @returns {{task: Object}} the created task (201)
 */
const createTask = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const { assignToAll, assignedTo, ...fields } = req.body;

  // "Everyone" is a task EACH, not one task with many names on it: a task is
  // something a person marks done, and a shared row would be done by whoever
  // got there first. Built here rather than looped by the client so the
  // recipient list obeys the same rules as every other people list — active
  // accounts, no system logins, no executives unless a SuperAdmin opted them
  // in, and the caller's own company only.
  if (assignToAll) {
    // pickablePeople, not the bare filter: it also drops anyone serving out a
    // notice period, who is in no picker anywhere else either.
    const people = await pickablePeople(req);
    if (!people.length) {
      res.status(400);
      throw new Error('There is nobody to assign this task to.');
    }
    const tasks = await Task.insertMany(
      people.map((u) => ({ ...fields, assignedTo: u._id, createdBy: req.user._id }))
    );
    // One message, many recipients — notifyMany writes the rows in one insert
    // and pushes once, instead of a per-person round trip for a fan-out that can
    // be the whole company. The body is the same for everyone because the task
    // is: only the row it hangs on differs.
    notifyMany(
      tasks.map((t) => t.assignedTo).filter((id) => String(id) !== String(req.user._id)),
      {
        type: 'task',
        audience: 'employee',
        title: 'New task assigned',
        body: `"${tasks[0].title}"${taskMeta(tasks[0])}`,
        link: EMPLOYEE_LINK,
      }
    ).catch(() => {});
    return res.status(201).json({ count: tasks.length, tasks });
  }

  const task = await Task.create({ ...fields, assignedTo: assignedTo || undefined, createdBy: req.user._id });
  notifyAssigned(task, req.user._id).catch(() => {});
  res.status(201).json({ count: 1, task });
});

/**
 * Update a task by id (partial update via Object.assign).
 * @route PUT /api/tasks/:id
 * @param {string} req.params.id - task id
 * @param {Object} req.body - fields to update
 * @returns {{task: Object}} the updated task
 */
const updateTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;

  // Snapshot BEFORE the assign: the admin form PUTs the whole task on every
  // save, so the only way to tell a real edit from a no-op re-save is to
  // compare against what was there. Without it every "Save" would notify.
  const was = {
    assignedTo: task.assignedTo,
    ...Object.fromEntries(WATCHED_FIELDS.map(([field]) => [field, task[field]])),
  };

  Object.assign(task, req.body);
  await task.save();

  const reassigned = task.assignedTo && !sameValue(was.assignedTo, task.assignedTo);
  if (reassigned) {
    // A new owner is a new assignment, not an edit — they have never seen this
    // task, so naming the fields that moved would mean nothing to them.
    notifyAssigned(task, req.user._id).catch(() => {});
  } else {
    const changed = WATCHED_FIELDS
      .filter(([field]) => !sameValue(was[field], task[field]))
      .map(([, label]) => label);
    notifyTaskEdited(task, changed, req.user._id).catch(() => {});
  }

  res.json({ task });
});

/**
 * Delete a task by id.
 * @route DELETE /api/tasks/:id
 * @param {string} req.params.id - task id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  await task.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Employee self-service =====
/**
 * List tasks assigned to the current user, ordered by due date.
 * @route GET /api/tasks/me
 * @returns {{count: number, tasks: Object[]}} the user's tasks with populated project
 */
const listMyTasks = asyncHandler(async (req, res) => {
  const tasks = await Task.find({ assignedTo: req.user._id })
    .populate('project', 'name status')
    .sort({ dueDate: 1, createdAt: -1 });
  res.json({ count: tasks.length, tasks });
});

/**
 * Assignee moves their own task's status (self-service, cannot edit others').
 * @route PATCH /api/tasks/me/:id/status
 * @param {string} req.params.id - task id
 * @param {string} req.body.status - new status, must be one of TASK_STATUS
 * @returns {{task: Object}} the updated task
 */
// PATCH /api/tasks/me/:id/status  — assignee may move their own task's status
const updateMyTaskStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUS.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${TASK_STATUS.join(', ')}`);
  }
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  // Permission gate: only the assignee may change the status
  if (!task.assignedTo || !task.assignedTo.equals(req.user._id)) {
    res.status(403);
    throw new Error('You can only update tasks assigned to you');
  }
  const from = task.status;
  task.status = status;
  await task.save();

  // Only a real move is news. Re-picking the status a task already has is a
  // dropdown that fired, not a change, and HR should not hear about it.
  if (from !== status) notifyOwnerOfStatusChange(task, req.user, from, status).catch(() => {});

  res.json({ task });
});

module.exports = {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listMyTasks,
  updateMyTaskStatus,
  TASK_STATUS,
  TASK_PRIORITY,
  // Exported for scripts/backfillTaskNotifications.js, so a backfilled alert is
  // worded and linked identically to one the module sends now. Two copies of
  // the sentence would drift the moment either is touched.
  taskMeta,
  EMPLOYEE_LINK,
};
