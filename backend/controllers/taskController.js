/**
 * Task controller — the task itself: creating it, changing it, handing it over,
 * and every move along its lifecycle.
 *
 * The rest of the module lives next door: submissions, approvals, comments,
 * time and extensions in taskWorkController.js; workflows, templates and
 * recurrence in taskWorkflowController.js; dashboards and exports in
 * taskAnalyticsController.js. Splitting it that way keeps each file about one
 * job, and keeps this one about the task.
 *
 * NOTHING IN HERE MOVES A STATUS BY HAND. Every transition goes through
 * services/taskEngine.transition, which is what enforces the legal moves, the
 * concurrency guard, the server-side timestamps and the activity trail. A
 * handler that wrote `task.status = 'COMPLETED'` would bypass all four, so none
 * of them does.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const TaskSubmission = require('../models/TaskSubmission');
const TaskTimeEntry = require('../models/TaskTimeEntry');
const TaskActivity = require('../models/TaskActivity');
const TaskComment = require('../models/TaskComment');
const TaskExtension = require('../models/TaskExtension');
const TaskIncentive = require('../models/TaskIncentive');
const TaskTemplate = require('../models/TaskTemplate');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

const engine = require('../services/taskEngine');
const access = require('../services/taskAccess');
const flow = require('../services/taskWorkflow');
const incentives = require('../services/taskIncentive');
const notify = require('../services/taskNotify');
const { buildTaskFromTemplate } = require('../services/taskTemplates');

const { pickablePeople } = require('../utils/peoplePicker');
const {
  TASK_STATUS, TASK_PRIORITY, BOARD_COLUMNS, ASSIGNEE_ROLES,
  normaliseStatus, statusLabel, isTerminal, ACCEPT_WINDOW_HOURS,
} = require('../config/taskWorkflow');

const USER_FIELDS = 'firstName lastName email role photo';
const { httpError, fullName } = engine;

// ===== Shared helpers =====

/**
 * Turn whatever the client sent for "who is on this task" into assignee rows,
 * with the names frozen onto them.
 *
 * Accepts three shapes, because three clients send three: a bare id (the old
 * API and the current Android build), an array of ids, and the full objects the
 * new web form posts. One function so a caller never has to care which.
 *
 * @param {Array|string} input
 * @param {object} [opts]
 * @param {boolean} [opts.markOwner] - force the first row to be the Owner
 * @returns {Promise<Array>} assignee rows
 */
async function buildAssignees(input, opts = {}) {
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  const rows = raw
    .map((x) => (typeof x === 'string' || x instanceof mongoose.Types.ObjectId
      ? { user: String(x) }
      : { ...x, user: String(x.user || x._id || '') }))
    .filter((x) => x.user && mongoose.isValidObjectId(x.user));

  if (!rows.length) return [];

  const ids = rows.map((r) => r.user);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('firstName lastName').lean(),
    EmployeeProfile.find({ user: { $in: ids } }).select('user employeeCode').lean(),
  ]);
  const byUser = new Map(users.map((u) => [String(u._id), u]));
  const codeOf = new Map(profiles.map((p) => [String(p.user), p.employeeCode]));

  const out = rows.map((r, i) => {
    const u = byUser.get(r.user);
    return {
      user: r.user,
      name: u ? fullName(u) : undefined,
      employeeCode: codeOf.get(r.user),
      role: ASSIGNEE_ROLES.includes(r.role) ? r.role : (i === 0 && opts.markOwner !== false ? 'Owner' : 'Contributor'),
      responsibility: r.responsibility,
      dueDate: r.dueDate || undefined,
      status: 'ASSIGNED',
      incentiveEligible: r.incentiveEligible !== false,
    };
  });

  // Exactly one Owner. Several clients can each believe they are setting the
  // primary, and `assignedTo` mirrors whoever holds the badge — two of them
  // would make which one it mirrors depend on array order.
  if (!out.some((a) => a.role === 'Owner')) out[0].role = 'Owner';
  let seenOwner = false;
  for (const a of out) {
    if (a.role !== 'Owner') continue;
    if (seenOwner) a.role = 'Contributor';
    seenOwner = true;
  }
  return out;
}

/**
 * The company a task belongs to, for the wall.
 *
 * Taken from the primary assignee's employee record, falling back to the
 * creator's. Snapshot onto the task so a list query does not have to join
 * through EmployeeProfile on every row.
 * @param {*} primaryUserId
 * @param {object} actor - req.user
 * @returns {Promise<*|undefined>}
 */
async function resolveCompany(primaryUserId, actor) {
  const candidates = [primaryUserId, actor && actor._id].filter(Boolean);
  for (const id of candidates) {
    const prof = await EmployeeProfile.findOne({ user: id }).select('company department').lean();
    if (prof && prof.company) return { company: prof.company, department: prof.department };
  }
  if (actor && actor.scopeCompanyId) return { company: actor.scopeCompanyId };
  return {};
}

/** The fields an assignee is told about when a manager edits their task. */
const WATCHED_FIELDS = [
  ['title', 'title'],
  ['description', 'description'],
  ['priority', 'priority'],
  ['dueDate', 'due date'],
  ['startDate', 'start date'],
  ['status', 'status'],
  ['project', 'project'],
  ['estimatedMinutes', 'estimated time'],
];

/**
 * Are two task field values the same thing?
 *
 * The admin form PUTs the whole task on every save, so "what changed" can only
 * be answered by comparing against the pre-update document — and the values
 * arrive in three shapes: a Date against an ISO string from a date input, an
 * ObjectId against its hex string, and plain strings. Compared naively, every
 * save would look like a change and notify the assignee about nothing.
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

/** The position a client sent with an action, if any, as plain numbers. */
function readPosition(body = {}) {
  const src = body.location || body;
  const lat = Number(src.lat ?? src.latitude);
  const lng = Number(src.lng ?? src.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    accuracy: Number(src.accuracy) || undefined,
    address: src.address ? String(src.address).slice(0, 300) : undefined,
  };
}

// ===== Listing =====

/**
 * List tasks the caller may see, filtered and paged.
 *
 * SERVER-SIDE EVERYTHING (section 46). The filters, the search, the sort and the
 * paging all run in Mongo; the client never receives more than one page, which
 * is what keeps this usable when a company has fifty thousand tasks rather than
 * fifty.
 *
 * @route GET /api/tasks
 * @param {string} [req.query.status] - one status, or several comma-separated
 * @param {string} [req.query.view] - 'mine' | 'team' | 'created' | 'approvals' | 'overdue' | 'dueToday'
 * @param {string} [req.query.q] - free text over code, title, description, tags
 * @returns {{count:number, total:number, page:number, pages:number, tasks:Object[]}}
 */
const listTasks = asyncHandler(async (req, res) => {
  const {
    status, priority, department, project, assignedTo, supervisor, workflow,
    taskType, category, tag, view, q, from, to, parentTask, archived,
    page = 1, limit = 50, sort = '-createdAt',
  } = req.query;

  const filter = { ...(await access.visibilityFilter(req)) };
  const and = [];

  if (status) {
    const wanted = String(status).split(',').map((s) => normaliseStatus(s.trim())).filter(Boolean);
    if (wanted.length) {
      // Both vocabularies, so an un-migrated row still matches its own filter.
      const all = wanted.flatMap((s) => engine.legacyAliases(s));
      and.push({ status: { $in: all } });
    }
  }
  if (priority) and.push({ priority: { $in: String(priority).split(',') } });
  if (department) and.push({ department });
  if (taskType) and.push({ taskType });
  if (category) and.push({ category });
  if (tag) and.push({ tags: tag });
  if (project && mongoose.isValidObjectId(project)) and.push({ project });
  if (workflow && mongoose.isValidObjectId(workflow)) and.push({ workflowRef: workflow });
  if (assignedTo && mongoose.isValidObjectId(assignedTo)) {
    and.push({ $or: [{ assignedTo }, { 'assignees.user': assignedTo }] });
  }
  if (supervisor && mongoose.isValidObjectId(supervisor)) and.push({ supervisor });
  if (parentTask) {
    and.push(parentTask === 'none' ? { parentTask: null } : { parentTask });
  }

  // Archived is OUT of every list unless asked for — an archive that still
  // showed up everywhere would not be an archive.
  if (archived === 'true') and.push({ archived: true });
  else if (archived !== 'all') and.push({ archived: { $ne: true } });

  const me = req.user._id;
  const now = new Date();
  switch (view) {
    case 'mine':
      and.push({ $or: [{ assignedTo: me }, { 'assignees.user': me }] });
      break;
    case 'created':
      and.push({ createdBy: me });
      break;
    case 'team': {
      const reports = await access.directReportUserIds(me);
      and.push({
        $or: [
          { supervisor: me }, { manager: me },
          ...(reports.length ? [{ assignedTo: { $in: reports } }, { 'assignees.user': { $in: reports } }] : []),
        ],
      });
      break;
    }
    case 'approvals':
      and.push({ pendingApprovers: me });
      break;
    case 'overdue':
      and.push({ dueDate: { $lt: now }, status: { $nin: ['COMPLETED', 'CANCELLED', 'DECLINED', 'Done'] } });
      break;
    case 'dueToday': {
      const { istDayRange } = require('../utils/istDate');
      const { istDateString } = require('../utils/istDate');
      const { start, end } = istDayRange(istDateString(now));
      and.push({ dueDate: { $gte: start, $lte: end }, status: { $nin: ['COMPLETED', 'CANCELLED', 'DECLINED', 'Done'] } });
      break;
    }
    default:
      break;
  }

  if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(`${to}T23:59:59.999`);
    and.push({ dueDate: range });
  }

  if (q && String(q).trim()) {
    // Escaped, so a search for "C++" or "50% (draft)" is a search and not a
    // regex the user accidentally wrote.
    const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    and.push({ $or: [{ code: re }, { title: re }, { description: re }, { tags: re }, { taskType: re }] });
  }

  if (and.length) filter.$and = and;

  const perPage = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = (Math.max(1, Number(page) || 1) - 1) * perPage;
  const order = String(sort).startsWith('-')
    ? { [String(sort).slice(1)]: -1 }
    : { [String(sort)]: 1 };

  const [tasks, total] = await Promise.all([
    Task.find(filter)
      .populate('assignedTo', USER_FIELDS)
      .populate('assignees.user', USER_FIELDS)
      .populate('supervisor', 'firstName lastName')
      .populate('project', 'name status')
      .sort(order)
      .skip(skip)
      .limit(perPage)
      .lean(),
    Task.countDocuments(filter),
  ]);

  res.json({
    count: tasks.length,
    total,
    page: Number(page) || 1,
    pages: Math.ceil(total / perPage) || 1,
    tasks: tasks.map(decorate),
  });
});

/**
 * Add the derived facts every client needs and none should compute for itself —
 * whether a task is late, how late, and which board column it sits in.
 * @param {object} task - a lean task
 * @returns {object}
 */
function decorate(task) {
  const status = normaliseStatus(task.status) || task.status;
  const open = !isTerminal(status);
  const overdue = !!(open && task.dueDate && new Date(task.dueDate) < new Date());
  return {
    ...task,
    status,
    statusLabel: statusLabel(status),
    overdue,
    hoursLate: overdue
      ? Math.round((Date.now() - new Date(task.dueDate).getTime()) / 36000) / 100
      : 0,
    column: require('../config/taskWorkflow').columnOf(status),
  };
}

/**
 * The same tasks, grouped into board columns (section 27's Kanban view).
 * @route GET /api/tasks/board
 */
const taskBoard = asyncHandler(async (req, res) => {
  const filter = { ...(await access.visibilityFilter(req)), archived: { $ne: true } };
  if (req.query.view === 'mine') {
    filter.$and = [{ $or: [{ assignedTo: req.user._id }, { 'assignees.user': req.user._id }] }];
  }
  const tasks = await Task.find(filter)
    .populate('assignedTo', USER_FIELDS)
    .select('code title status priority dueDate progress assignedTo department taskType')
    .sort({ dueDate: 1, createdAt: -1 })
    .limit(500)
    .lean();

  const columns = BOARD_COLUMNS.map((c) => ({ ...c, tasks: [] }));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const t of tasks) {
    const d = decorate(t);
    const col = byKey.get(d.column);
    if (col) col.tasks.push(d);
  }
  res.json({ columns });
});

/**
 * One task, with everything the detail page shows.
 *
 * Deliberately one request rather than nine. The page has ten tabs and a person
 * clicking between them should not wait for the network each time; the heavy
 * lists (activity, submissions, comments) are capped here and paged by their own
 * endpoints when somebody scrolls.
 *
 * @route GET /api/tasks/:id
 */
const getTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id);

  const [activity, submissions, comments, timeEntries, extensions, award, subtasks, blockers] = await Promise.all([
    TaskActivity.find({ task: task._id }).sort({ at: 1 }).limit(200).lean(),
    TaskSubmission.find({ task: task._id }).sort({ submittedAt: -1 }).limit(50).lean(),
    TaskComment.find({ task: task._id, deletedAt: null }).sort({ createdAt: 1 }).limit(200).lean(),
    TaskTimeEntry.find({ task: task._id }).sort({ startedAt: -1 }).limit(200).lean(),
    TaskExtension.find({ task: task._id }).sort({ requestedAt: -1 }).lean(),
    TaskIncentive.find({ task: task._id }).lean(),
    Task.find({ parentTask: task._id }).select('code title status priority dueDate progress assignedTo')
      .populate('assignedTo', USER_FIELDS).lean(),
    engine.unmetDependencies(task),
  ]);

  const roles = engine.actorRoles(task, req.user);
  const status = normaliseStatus(task.status) || task.status;

  res.json({
    task: {
      ...task.toObject(),
      status,
      statusLabel: statusLabel(status),
      overdue: task.isOverdue(),
    },
    // What THIS person may do with it right now. The clients draw their buttons
    // from this rather than re-deriving the rules, which is what stops a button
    // appearing that the server then refuses.
    can: {
      edit: roles.includes('admin') || String(task.createdBy?._id || task.createdBy) === String(req.user._id)
        || String(task.supervisor?._id || task.supervisor) === String(req.user._id),
      review: task.isReviewer(req.user._id) || roles.includes('admin'),
      work: task.isAssignee(req.user._id),
      manage: roles.includes('admin'),
    },
    roles,
    transitions: require('../config/taskWorkflow').transitionsFrom(status)
      .filter((t) => t.actors.some((a) => roles.includes(a)))
      .map((t) => ({ to: t.to, label: statusLabel(t.to), needsReason: !!t.reason })),
    workflow: flow.outline(task),
    requirements: engine.requirementLabels(task),
    activity,
    submissions,
    comments: comments.filter((c) => !c.internal || task.isReviewer(req.user._id) || roles.includes('admin')),
    timeEntries,
    extensions,
    incentives: award,
    subtasks: subtasks.map(decorate),
    blockers,
  });
});

// ===== Creating =====

/**
 * Create a task.
 *
 * @route POST /api/tasks
 * @param {string} req.body.title - required
 * @param {Array} [req.body.assignees] - ids or {user, role, responsibility, dueDate}
 * @param {string} [req.body.assignedTo] - the old single-assignee shape; still accepted
 * @param {boolean} [req.body.assignToAll] - one task EACH for every employee
 * @param {string} [req.body.template] - build from a TaskTemplate
 * @param {string} [req.body.workflow] - run it through a workflow
 * @returns {{count:number, task?:Object, tasks?:Object[]}} 201
 */
const createTask = asyncHandler(async (req, res) => {
  const body = { ...req.body };

  // From a template: the template supplies the shape, the body overrides it.
  if (body.template && mongoose.isValidObjectId(body.template)) {
    const tpl = await TaskTemplate.findById(body.template);
    if (!tpl) throw httpError(400, 'That template does not exist.');
    const built = await buildTaskFromTemplate(tpl, {
      actor: req.user,
      subject: body.subject,
      overrides: body,
    });
    Object.assign(body, built, { template: tpl._id });
  }

  if (!String(body.title || '').trim()) throw httpError(400, 'A task needs a title.');

  const { assignToAll, assignees, assignedTo, workflow, subtasks, ...fields } = body;

  // ===== "Everyone" is a task EACH =====
  // A task is something ONE person marks done; a shared row would be done by
  // whoever got there first. Built on the server rather than looped by the
  // client so the recipient list obeys the same rules as every other people list
  // — active accounts, no system logins, no executives unless a SuperAdmin
  // opted them in, nobody serving out a notice period, and the caller's own
  // company only.
  if (assignToAll) {
    if (!access.canManage(req.user)) {
      throw httpError(403, 'Only somebody who manages tasks can set one for everybody.');
    }
    const people = await pickablePeople(req);
    if (!people.length) throw httpError(400, 'There is nobody to assign this task to.');

    const made = [];
    for (const person of people) {
      const rows = await buildAssignees([person._id]);
      const { company, department } = await resolveCompany(person._id, req.user);
      const task = new Task({
        ...fields,
        assignees: rows,
        createdBy: req.user._id,
        company: fields.company || company,
        department: fields.department || department,
        supervisor: fields.supervisor || req.user._id,
      });
      await task.save();
      made.push(task);
      engine.logActivity({
        task: task._id,
        kind: 'created',
        by: req.user,
        message: `${fullName(req.user)} created the task and assigned it to ${rows[0].name || 'somebody'}`,
        ip: req.ip,
      });
    }

    // One message, many recipients — notifyMany writes the rows in one insert
    // and pushes once, instead of a per-person round trip for a fan-out that can
    // be the whole company.
    notify.assigned(made[0], made.map((t) => t.assignedTo), req.user).catch(() => {});

    return res.status(201).json({ count: made.length, tasks: made });
  }

  const rows = await buildAssignees(assignees || assignedTo);
  const primary = rows.length ? rows[0].user : null;
  const { company, department } = await resolveCompany(primary, req.user);

  const task = new Task({
    ...fields,
    assignees: rows,
    createdBy: req.user._id,
    company: fields.company || company,
    department: fields.department || department,
    // The person who set the task watches it unless somebody else was named.
    supervisor: fields.supervisor || req.user._id,
  });

  // The manager who assigns the task is the one who sets its incentive, so the
  // proposal is stamped with their name whatever the client sent.
  if (task.incentive && task.incentive.enabled) {
    task.incentive.setBy = req.user._id;
    task.incentive.setByName = fullName(req.user);
  }

  if (workflow && mongoose.isValidObjectId(workflow)) {
    await flow.start(task, workflow);
  }

  await task.save();

  await engine.logActivity({
    task: task._id,
    kind: 'created',
    by: req.user,
    message: `${fullName(req.user)} created the task`
      + (rows.length ? ` and assigned it to ${rows.map((r) => r.name).filter(Boolean).join(', ')}` : ''),
    ip: req.ip,
  });

  // Subtasks named on the creating form (or brought in by a template).
  if (Array.isArray(subtasks) && subtasks.length) {
    for (const st of subtasks) {
      if (!String(st.title || '').trim()) continue;
      const stRows = await buildAssignees(st.assignees || st.assignedTo || primary);
      const child = new Task({
        title: st.title,
        description: st.description,
        parentTask: task._id,
        project: task.project,
        department: task.department,
        company: task.company,
        priority: st.priority || task.priority,
        dueDate: st.dueDate || task.dueDate,
        assignees: stRows,
        supervisor: task.supervisor,
        createdBy: req.user._id,
      });
      await child.save();
      notify.assigned(child, stRows.map((r) => r.user), req.user).catch(() => {});
    }
    await engine.recomputeRollups(task._id);
  }

  if (rows.length) notify.assigned(task, rows.map((r) => r.user), req.user).catch(() => {});

  const saved = await Task.findById(task._id)
    .populate('assignedTo', USER_FIELDS)
    .populate('assignees.user', USER_FIELDS);

  res.status(201).json({ count: 1, task: saved });
});

// ===== Editing =====

/**
 * Update a task's substance. Not its status — that is `changeStatus`.
 *
 * @route PATCH /api/tasks/:id
 * @route PUT /api/tasks/:id   (the old shape; same handler)
 */
const updateTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanEdit(req, task);

  // Fields a client may never set directly. `status` has its own gated route so
  // the state machine cannot be walked around; the stamps and counters are the
  // server's (section 37); `code` is quoted in emails and never rewritten.
  const FORBIDDEN = [
    'code', 'createdBy', 'status', 'progress', 'originalDueDate',
    'assignedAt', 'acceptedAt', 'startedAt', 'submittedAt', 'approvedAt',
    'completedAt', 'closedAt', 'firstOverdueAt', 'minutesLogged',
    'rejectionCount', 'extensionCount', 'handoverCount', 'commentCount',
    'subtaskCount', 'subtaskDoneCount', 'firedReminders', 'escalationLevel',
    'workflowSteps', 'currentStepKey', 'pendingApprovers', 'workflowVersion',
    'recurringTask', 'occurrenceKey',
  ];
  const body = { ...req.body };
  for (const f of FORBIDDEN) delete body[f];

  const was = {
    assignees: (task.assignees || []).map((a) => String(a.user)),
    ...Object.fromEntries(WATCHED_FIELDS.map(([f]) => [f, task[f]])),
  };

  // Assignees arrive as a whole list; merge rather than replace, so a person who
  // has already accepted and logged four hours does not have their row — and
  // their history on this task — silently rebuilt from scratch.
  if (body.assignees !== undefined) {
    const wanted = await buildAssignees(body.assignees);
    const existing = new Map((task.assignees || []).map((a) => [String(a.user), a]));
    task.assignees = wanted.map((w) => {
      const prev = existing.get(String(w.user));
      if (!prev) return w;
      prev.role = w.role;
      prev.responsibility = w.responsibility;
      prev.dueDate = w.dueDate;
      prev.incentiveEligible = w.incentiveEligible;
      return prev;
    });
    delete body.assignees;
  }

  // Moving the deadline by editing is still an extension of sorts — but it is
  // the MANAGER moving it, not the employee asking, so it is recorded on the
  // trail rather than routed through an approval.
  const movingDue = body.dueDate !== undefined && !sameValue(task.dueDate, body.dueDate);

  Object.assign(task, body);

  if (task.incentive && task.incentive.enabled && task.isModified('incentive')) {
    task.incentive.setBy = req.user._id;
    task.incentive.setByName = fullName(req.user);
  }

  await task.save();

  const nowIds = (task.assignees || []).map((a) => String(a.user));
  const added = nowIds.filter((id) => !was.assignees.includes(id));
  const removed = was.assignees.filter((id) => !nowIds.includes(id));

  const changed = WATCHED_FIELDS
    .filter(([f]) => !sameValue(was[f], task[f]))
    .map(([, label]) => label);

  if (changed.length || added.length || removed.length) {
    await engine.logActivity({
      task: task._id,
      kind: added.length || removed.length ? 'reassigned' : 'updated',
      by: req.user,
      message: `${fullName(req.user)} updated the task`
        + (changed.length ? ` — ${changed.join(', ')}` : '')
        + (added.length ? `; added ${added.length} assignee${added.length === 1 ? '' : 's'}` : '')
        + (removed.length ? `; removed ${removed.length}` : ''),
      field: movingDue ? 'dueDate' : undefined,
      from: movingDue ? was.dueDate : undefined,
      to: movingDue ? task.dueDate : undefined,
      ip: req.ip,
    });
  }

  // A new owner is a new assignment, not an edit — naming the fields that moved
  // would mean nothing to somebody who has never seen the task.
  if (added.length) notify.assigned(task, added, req.user).catch(() => {});
  const told = nowIds.filter((id) => !added.includes(id));
  if (changed.length && told.length) notify.edited(task, told, changed, req.user).catch(() => {});

  const saved = await Task.findById(task._id)
    .populate('assignedTo', USER_FIELDS)
    .populate('assignees.user', USER_FIELDS);
  res.json({ task: saved });
});

/**
 * Archive or delete a task.
 *
 * ARCHIVING IS THE DEFAULT and deleting needs `tasks.manage` plus an explicit
 * ask, because a task is the anchor for its submissions, its time entries, its
 * trail and possibly an incentive somebody has been paid for. A task that has
 * ever been credited is never deleted — the credit would be left pointing at
 * nothing.
 *
 * @route DELETE /api/tasks/:id
 * @param {string} [req.query.hard] - 'true' to really delete
 */
const deleteTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanEdit(req, task);

  const hard = String(req.query.hard) === 'true';
  if (!hard) {
    task.archived = true;
    await task.save();
    await engine.logActivity({
      task: task._id, kind: 'archived', by: req.user,
      message: `${fullName(req.user)} archived the task`, ip: req.ip,
    });
    return res.json({ id: task._id, archived: true });
  }

  if (!access.canManage(req.user)) {
    throw httpError(403, 'Only somebody who manages tasks can delete one. You can archive it instead.');
  }
  const credited = await TaskIncentive.countDocuments({ task: task._id, status: 'Credited' });
  if (credited) {
    throw httpError(409, 'Points have already been credited for this task, so it cannot be deleted. Archive it instead.');
  }
  const children = await Task.countDocuments({ parentTask: task._id });
  if (children) {
    throw httpError(409, `This task has ${children} subtask${children === 1 ? '' : 's'}. Delete or move ${children === 1 ? 'it' : 'them'} first.`);
  }

  // The trail outlives the task deliberately — it is the record that the task
  // existed and who deleted it. Everything else that only makes sense with the
  // task goes with it.
  await Promise.all([
    TaskSubmission.deleteMany({ task: task._id }),
    TaskTimeEntry.deleteMany({ task: task._id }),
    TaskComment.deleteMany({ task: task._id }),
    TaskExtension.deleteMany({ task: task._id }),
    TaskIncentive.deleteMany({ task: task._id, status: { $ne: 'Credited' } }),
  ]);
  await engine.logActivity({
    task: task._id, kind: 'archived', by: req.user,
    message: `${fullName(req.user)} DELETED the task "${task.title}"`, ip: req.ip,
  });
  await task.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Lifecycle =====

/**
 * Move a task to any status the caller is entitled to move it to.
 *
 * The general-purpose route. The named ones below (accept, decline, start) exist
 * because they do more than move a status — they carry a location, check a
 * geofence, or touch the assignee's own row — but they all end up here.
 *
 * @route POST /api/tasks/:id/status
 * @param {string} req.body.status
 * @param {string} [req.body.note] - required for some moves
 */
const changeStatus = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const to = normaliseStatus(req.body.status);
  if (!to) throw httpError(400, `Status must be one of: ${TASK_STATUS.join(', ')}.`);

  const from = normaliseStatus(task.status) || task.status;
  const updated = await engine.transition(task, to, req.user, {
    note: req.body.note,
    ip: req.ip,
    idempotent: true,
  });

  // A single-assignee task's row IS the task, so keep them in step.
  if ((updated.assignees || []).length === 1) {
    engine.syncAssigneeStatus(updated, to);
    await updated.save();
  }

  const who = access.audienceOf(updated);
  if (task.isAssignee(req.user._id) && !access.canManage(req.user)) {
    let watchers = who.reviewers;
    if (!watchers.length) watchers = await access.managerBench(updated, req.user.scopeCompanyId);
    notify.movedByAssignee(updated, watchers, req.user, from, to).catch(() => {});
  } else {
    notify.edited(updated, who.assignees, ['status'], req.user).catch(() => {});
  }

  if (to === 'COMPLETED') await onCompleted(updated, req.user);

  res.json({ task: updated });
});

/**
 * Everything that follows a task being completed.
 *
 * Kept in one function rather than repeated at the three places a task can
 * reach COMPLETED (a direct move, the last workflow step, an approval with no
 * workflow), because a completion that skipped the incentive or the parent
 * roll-up would be a silent loss rather than an error anybody notices.
 * @param {object} task
 * @param {object} actor
 */
async function onCompleted(task, actor) {
  try {
    engine.syncAssigneeStatus(task, 'COMPLETED');
    await task.save();

    const who = access.audienceOf(task);
    notify.completed(task, who.assignees).catch(() => {});

    // Points, if the manager set any. Proposed only — somebody else sanctions.
    const awards = await incentives.evaluate(task);
    const worth = awards.filter((a) => a.status === 'Pending' && a.points > 0);
    if (worth.length) {
      const bench = await access.managerBench(task, task.company);
      for (const a of worth) {
        notify.incentivePending(task, bench, a.points, a.name || 'an employee').catch(() => {});
      }
    }

    // A parent's progress is its children's.
    if (task.parentTask) await engine.recomputeRollups(task.parentTask);

    // Anything waiting on this one can now be started; tell whoever holds it.
    const unblocked = await Task.find({
      'dependencies.task': task._id,
      status: { $nin: ['COMPLETED', 'CANCELLED', 'DECLINED'] },
    }).select('title code assignees assignedTo dueDate priority').lean();
    for (const other of unblocked) {
      const still = await engine.unmetDependencies(other);
      if (still.length) continue;
      notify.assigned(other, [other.assignedTo], actor, 'Task unblocked').catch(() => {});
    }
  } catch (err) {
    console.error('Post-completion work failed:', err.message);
  }
}

/**
 * Accept a task you were given (section 10).
 * @route POST /api/tasks/:id/accept
 */
const acceptTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  const position = await engine.checkGeofence(task, 'accept', readPosition(req.body), req.user._id);

  const updated = await engine.transition(task, 'ACCEPTED', req.user, {
    note: req.body.note,
    location: position,
    locationEvent: 'accept',
    ip: req.ip,
    idempotent: true,
  });

  engine.syncAssigneeStatus(updated, 'ACCEPTED', req.user._id);
  await updated.save();

  const who = access.audienceOf(updated);
  notify.movedByAssignee(updated, who.reviewers, req.user, 'ASSIGNED', 'ACCEPTED').catch(() => {});
  res.json({ task: updated });
});

/**
 * Refuse a task, with a reason (section 10).
 * @route POST /api/tasks/:id/decline
 */
const declineTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  const reason = String(req.body.reason || req.body.note || '').trim();
  if (!reason) throw httpError(400, 'Say why you cannot take this task.');

  const row = task.assigneeRow(req.user._id);
  if (row) {
    row.status = 'DECLINED';
    row.declinedAt = new Date();
    row.declineReason = reason.slice(0, 500);
  }

  // On a task with several people, one person declining is their row changing,
  // not the whole task being refused — the others carry on.
  const everyone = (task.assignees || []).filter((a) => a.role !== 'Observer');
  const allDeclined = everyone.length > 0 && everyone.every((a) => a.status === 'DECLINED');

  let updated = task;
  if (allDeclined || everyone.length <= 1) {
    updated = await engine.transition(task, 'DECLINED', req.user, { note: reason, ip: req.ip });
    // The row edits above were made on `task`; re-apply them to the document the
    // conditional update handed back, or they are lost.
    const fresh = updated.assigneeRow(req.user._id);
    if (fresh) {
      fresh.status = 'DECLINED';
      fresh.declinedAt = new Date();
      fresh.declineReason = reason.slice(0, 500);
    }
    await updated.save();
  } else {
    await task.save();
    await engine.logActivity({
      task: task._id, kind: 'declined', by: req.user,
      message: `${fullName(req.user)} declined their part of the task`, note: reason, ip: req.ip,
    });
  }

  let watchers = access.audienceOf(updated).reviewers;
  if (!watchers.length) watchers = await access.managerBench(updated, req.user.scopeCompanyId);
  notify.declined(updated, watchers, req.user, reason).catch(() => {});

  res.json({ task: updated });
});

/**
 * Start work. Where the dependency and geofence gates actually bite.
 * @route POST /api/tasks/:id/start
 */
const startTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  await engine.assertDependenciesMet(task);
  const position = await engine.checkGeofence(task, 'start', readPosition(req.body), req.user._id);

  const from = normaliseStatus(task.status) || task.status;
  const updated = await engine.transition(task, 'IN_PROGRESS', req.user, {
    location: position,
    locationEvent: 'start',
    ip: req.ip,
    idempotent: true,
  });

  engine.syncAssigneeStatus(updated, 'IN_PROGRESS', req.user._id);
  await updated.save();

  const who = access.audienceOf(updated);
  notify.movedByAssignee(updated, who.reviewers, req.user, from, 'IN_PROGRESS').catch(() => {});
  res.json({ task: updated });
});

/**
 * Tick or untick a checklist item (section 18).
 * @route PATCH /api/tasks/:id/checklist/:itemId
 */
const setChecklistItem = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const item = (task.checklist || []).id(req.params.itemId);
  if (!item) throw httpError(404, 'That checklist item is not on this task.');

  // An item addressed to one person is theirs to tick. An unaddressed one is
  // anybody's who is on the task.
  const mine = !item.assignee || String(item.assignee) === String(req.user._id);
  if (!mine && !access.canManage(req.user) && !task.isReviewer(req.user._id)) {
    throw httpError(403, 'That checklist item belongs to somebody else.');
  }
  if (!task.isAssignee(req.user._id) && !task.isReviewer(req.user._id) && !access.canManage(req.user)) {
    throw httpError(403, 'Only somebody on this task can work through its checklist.');
  }

  const done = req.body.done !== false;
  if (item.done === done) return res.json({ task });

  item.done = done;
  item.doneBy = done ? req.user._id : undefined;
  item.doneByName = done ? fullName(req.user) : undefined;
  item.doneAt = done ? new Date() : undefined;
  await task.save();

  await engine.logActivity({
    task: task._id,
    kind: 'checklist',
    by: req.user,
    message: `${fullName(req.user)} ${done ? 'ticked' : 'unticked'} "${item.text}"`,
    ip: req.ip,
  });

  res.json({ task, progress: task.progress });
});

/**
 * Set your own progress figure on a task that measures progress that way.
 * @route PATCH /api/tasks/:id/progress
 */
const setProgress = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  const pct = Math.max(0, Math.min(100, Number(req.body.progress)));
  if (!Number.isFinite(pct)) throw httpError(400, 'Progress must be a number between 0 and 100.');

  const row = task.assigneeRow(req.user._id);
  const was = row ? row.progress : task.progress;
  if (row) row.progress = pct;
  await task.save();

  await engine.logActivity({
    task: task._id, kind: 'progress', by: req.user,
    message: `${fullName(req.user)} set progress to ${pct}%`,
    field: 'progress', from: was, to: pct, ip: req.ip,
  });
  res.json({ task, progress: task.progress });
});

// ===== Assignees & handover =====

/**
 * Add somebody to a task (section 5 — a supervisor may "add assignee").
 * @route POST /api/tasks/:id/assignees
 */
const addAssignee = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanEdit(req, task);

  const rows = await buildAssignees(req.body.assignees || req.body.user || req.body.userId, { markOwner: false });
  if (!rows.length) throw httpError(400, 'Say who to add.');

  const have = new Set((task.assignees || []).map((a) => String(a.user)));
  const fresh = rows.filter((r) => !have.has(String(r.user)));
  if (!fresh.length) throw httpError(409, 'They are already on this task.');

  task.assignees.push(...fresh);
  await task.save();

  await engine.logActivity({
    task: task._id, kind: 'assigned', by: req.user,
    message: `${fullName(req.user)} added ${fresh.map((r) => r.name).filter(Boolean).join(', ')} to the task`,
    ip: req.ip,
  });
  notify.assigned(task, fresh.map((r) => r.user), req.user).catch(() => {});

  res.json({ task });
});

/**
 * Take somebody off a task.
 * @route DELETE /api/tasks/:id/assignees/:userId
 */
const removeAssignee = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanEdit(req, task);

  const before = (task.assignees || []).length;
  const gone = (task.assignees || []).find((a) => String(a.user) === String(req.params.userId));
  if (!gone) throw httpError(404, 'They are not on this task.');
  if (before === 1) {
    throw httpError(409, 'A task needs somebody on it. Hand it over instead, or cancel the task.');
  }

  task.assignees = (task.assignees || []).filter((a) => String(a.user) !== String(req.params.userId));
  await task.save();

  await engine.logActivity({
    task: task._id, kind: 'unassigned', by: req.user,
    message: `${fullName(req.user)} removed ${gone.name || 'somebody'} from the task`, ip: req.ip,
  });
  res.json({ task });
});

/**
 * Hand a task from one person to another (section 22).
 *
 * The task keeps its id, its code and its whole history — that is the point of a
 * handover rather than "cancel and re-create". The outgoing person's row is kept
 * on the task as a former assignee would be lost otherwise, along with the hours
 * they logged and the work they did.
 *
 * @route POST /api/tasks/:id/handover
 * @param {string} req.body.to - the new assignee
 * @param {string} req.body.reason - required
 * @param {string} [req.body.from] - who to replace; default the primary
 * @param {string} [req.body.remaining] - what is left to do
 */
const handoverTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });

  // The person holding the task may hand it on, and so may anyone who could
  // edit it. An assignee handing their own work over is the common case and
  // should not need an administrator.
  const isMine = task.isAssignee(req.user._id);
  if (!isMine) access.assertCanEdit(req, task);

  const reason = String(req.body.reason || '').trim();
  if (!reason) throw httpError(400, 'Say why the task is being handed over.');
  if (!mongoose.isValidObjectId(req.body.to)) throw httpError(400, 'Say who is taking it on.');

  const fromId = req.body.from && mongoose.isValidObjectId(req.body.from)
    ? String(req.body.from)
    : String(isMine ? req.user._id : (task.assignedTo || ''));

  const outgoing = (task.assignees || []).find((a) => String(a.user) === fromId);
  if (!outgoing) throw httpError(400, 'That person is not on this task.');
  if (String(req.body.to) === fromId) throw httpError(400, 'That is the same person.');
  if ((task.assignees || []).some((a) => String(a.user) === String(req.body.to))) {
    throw httpError(409, 'They are already on this task.');
  }

  const [incoming] = await buildAssignees([{
    user: req.body.to,
    role: outgoing.role,
    responsibility: outgoing.responsibility,
    dueDate: outgoing.dueDate,
  }], { markOwner: false });
  if (!incoming) throw httpError(400, 'That person does not exist.');

  // The incoming person starts where a new assignment starts — they have not
  // accepted anything yet, whatever the outgoing person had reached.
  incoming.status = 'ASSIGNED';
  incoming.progress = outgoing.progress || 0;

  task.assignees = (task.assignees || []).map((a) => (String(a.user) === fromId ? incoming : a));
  task.handoverCount = (task.handoverCount || 0) + 1;
  await task.save();

  const outName = outgoing.name || 'somebody';
  await engine.logActivity({
    task: task._id,
    kind: 'handover',
    by: req.user,
    message: `${fullName(req.user)} handed the task from ${outName} to ${incoming.name || 'somebody'}`,
    note: [reason, req.body.remaining && `Remaining: ${req.body.remaining}`].filter(Boolean).join(' — '),
    field: 'assignedTo',
    from: outName,
    to: incoming.name,
    ip: req.ip,
  });

  if (req.body.remaining || reason) {
    await TaskComment.create({
      task: task._id,
      author: req.user._id,
      authorName: fullName(req.user),
      authorRole: req.user.role,
      context: 'handover',
      body: [reason, req.body.remaining && `Remaining work: ${req.body.remaining}`].filter(Boolean).join('\n\n'),
    });
  }

  notify.handedOver(task, incoming.user, { firstName: outName }, req.user, req.body.remaining).catch(() => {});

  res.json({ task });
});

// ===== Employee self-service =====

/**
 * The signed-in person's own tasks.
 *
 * Kept as its own route rather than a filter on the list because it is the one
 * every employee client calls on load — the web My Tasks page and the app's home
 * screen — and it should be one indexed query with no permission reasoning at
 * all.
 *
 * @route GET /api/tasks/me
 */
const listMyTasks = asyncHandler(async (req, res) => {
  const { status, includeDone } = req.query;
  const filter = {
    $or: [{ assignedTo: req.user._id }, { 'assignees.user': req.user._id }],
    archived: { $ne: true },
  };
  if (status) {
    const wanted = String(status).split(',').map((s) => normaliseStatus(s.trim())).filter(Boolean);
    if (wanted.length) filter.status = { $in: wanted.flatMap(engine.legacyAliases) };
  } else if (includeDone !== 'true') {
    filter.status = { $nin: ['COMPLETED', 'CANCELLED', 'DECLINED', 'Done'] };
  }

  const tasks = await Task.find(filter)
    .populate('project', 'name status')
    .populate('supervisor', 'firstName lastName')
    .sort({ dueDate: 1, createdAt: -1 })
    .limit(300)
    .lean();

  res.json({ count: tasks.length, tasks: tasks.map(decorate) });
});

/**
 * The counts an employee's dashboard shows (section 29).
 *
 * One aggregate rather than seven list calls — the mistake that made the app's
 * launch fire twenty requests. Nothing here returns a task; it returns numbers.
 *
 * @route GET /api/tasks/me/summary
 */
const myTaskSummary = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const { istDateString, istDayRange } = require('../utils/istDate');
  const today = istDayRange(istDateString(new Date()));
  const mine = { $or: [{ assignedTo: me }, { 'assignees.user': me }], archived: { $ne: true } };
  const openStatuses = { $nin: ['COMPLETED', 'CANCELLED', 'DECLINED', 'Done'] };

  const [byStatus, dueToday, overdue, pendingApprovals, awaitingAccept, points, running] = await Promise.all([
    Task.aggregate([{ $match: mine }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Task.countDocuments({ ...mine, status: openStatuses, dueDate: { $gte: today.start, $lte: today.end } }),
    Task.countDocuments({ ...mine, status: openStatuses, dueDate: { $lt: new Date() } }),
    Task.countDocuments({ pendingApprovers: me, archived: { $ne: true } }),
    Task.countDocuments({ ...mine, status: { $in: ['ASSIGNED', 'Todo'] } }),
    TaskIncentive.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(String(me)) } },
      { $group: { _id: '$status', points: { $sum: '$points' } } },
    ]),
    TaskTimeEntry.findOne({ user: me, status: { $in: ['running', 'paused'] } }).lean(),
  ]);

  const counts = {};
  for (const row of byStatus) {
    const key = normaliseStatus(row._id) || row._id;
    counts[key] = (counts[key] || 0) + row.n;
  }
  const total = Object.values(counts).reduce((t, n) => t + n, 0);
  const completed = counts.COMPLETED || 0;

  const pointsBy = Object.fromEntries(points.map((p) => [p._id, Math.round(p.points * 100) / 100]));

  res.json({
    counts,
    total,
    open: total - completed - (counts.CANCELLED || 0) - (counts.DECLINED || 0),
    completed,
    dueToday,
    overdue,
    pendingApprovals,
    awaitingAccept,
    // On-time completion, as a plain honest percentage of completed tasks that
    // had a deadline — not a "productivity score" (section 49 warns against
    // inventing one).
    incentive: { earned: pointsBy.Credited || 0, pending: pointsBy.Pending || 0 },
    runningTimer: running ? { task: running.task, startedAt: running.startedAt, status: running.status } : null,
  });
});

// ===== Bulk (section 44) =====

/**
 * Act on many tasks at once.
 *
 * Every operation is applied task by task through the same guards a single call
 * would go through — a bulk route that wrote straight to the collection would be
 * a way around every permission and every transition rule in the module. It is
 * slower, and it is the only version that is correct.
 *
 * Partial success is reported rather than rolled back: with fifty tasks and two
 * refusals, undoing the other forty-eight helps nobody.
 *
 * @route POST /api/tasks/bulk
 * @param {string[]} req.body.ids
 * @param {string} req.body.action - 'assign'|'status'|'dueDate'|'priority'|'archive'|'supervisor'
 */
const bulkAction = asyncHandler(async (req, res) => {
  const { ids, action, value, note } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Choose some tasks first.');
  if (ids.length > 200) throw httpError(400, 'That is too many tasks at once — 200 is the limit.');

  const done = [];
  const failed = [];

  for (const id of ids) {
    try {
      const task = await access.loadVisibleTask(req, id, { populate: false });
      switch (action) {
        case 'status': {
          const to = normaliseStatus(value);
          if (!to) throw httpError(400, 'Unknown status.');
          await engine.transition(task, to, req.user, { note, ip: req.ip, idempotent: true });
          break;
        }
        case 'assign': {
          access.assertCanEdit(req, task);
          const rows = await buildAssignees(value);
          if (!rows.length) throw httpError(400, 'Say who to assign to.');
          task.assignees = rows;
          await task.save();
          notify.assigned(task, rows.map((r) => r.user), req.user).catch(() => {});
          await engine.logActivity({
            task: task._id, kind: 'reassigned', by: req.user,
            message: `${fullName(req.user)} reassigned the task in a bulk change`, note, ip: req.ip,
          });
          break;
        }
        case 'dueDate': {
          access.assertCanEdit(req, task);
          const was = task.dueDate;
          task.dueDate = value ? new Date(value) : undefined;
          await task.save();
          await engine.logActivity({
            task: task._id, kind: 'updated', by: req.user,
            message: `${fullName(req.user)} changed the due date in a bulk change`,
            field: 'dueDate', from: was, to: task.dueDate, note, ip: req.ip,
          });
          notify.edited(task, access.audienceOf(task).assignees, ['due date'], req.user).catch(() => {});
          break;
        }
        case 'priority': {
          access.assertCanEdit(req, task);
          if (!TASK_PRIORITY.includes(value)) throw httpError(400, 'Unknown priority.');
          task.priority = value;
          await task.save();
          break;
        }
        case 'supervisor': {
          access.assertCanEdit(req, task);
          if (!mongoose.isValidObjectId(value)) throw httpError(400, 'Say who supervises.');
          task.supervisor = value;
          await task.save();
          break;
        }
        case 'archive': {
          access.assertCanEdit(req, task);
          task.archived = value !== false;
          await task.save();
          await engine.logActivity({
            task: task._id, kind: task.archived ? 'archived' : 'restored', by: req.user,
            message: `${fullName(req.user)} ${task.archived ? 'archived' : 'restored'} the task`, ip: req.ip,
          });
          break;
        }
        default:
          throw httpError(400, `"${action}" is not something this can do in bulk.`);
      }
      done.push(id);
    } catch (err) {
      failed.push({ id, message: err.message });
    }
  }

  res.json({
    updated: done.length,
    failed,
    message: failed.length
      ? `${done.length} updated, ${failed.length} could not be.`
      : `${done.length} task${done.length === 1 ? '' : 's'} updated.`,
  });
});

/**
 * The lists and catalogues the task forms need, in one call.
 * @route GET /api/tasks/meta
 */
const taskMeta = asyncHandler(async (req, res) => {
  const cfg = require('../config/taskWorkflow');
  const Workflow = require('../models/Workflow');
  const [workflows, templates, types] = await Promise.all([
    Workflow.find({ active: true, activeVersion: { $ne: null } }).select('name activeVersion taskTypes').lean(),
    TaskTemplate.find({ active: true }).select('name taskType description trigger').lean(),
    Task.distinct('taskType'),
  ]);
  res.json({
    statuses: cfg.TASK_STATUS.map((s) => ({ key: s, label: cfg.statusLabel(s) })),
    priorities: cfg.TASK_PRIORITY,
    columns: cfg.BOARD_COLUMNS,
    assigneeRoles: cfg.ASSIGNEE_ROLES,
    requirements: Object.entries(cfg.REQUIREMENT_LABELS).map(([key, label]) => ({ key, label })),
    evidenceKinds: cfg.EVIDENCE_KINDS,
    locationEvents: cfg.LOCATION_EVENTS,
    geofenceRules: cfg.GEOFENCE_RULES,
    incentiveOutcomes: Object.entries(cfg.INCENTIVE_OUTCOME_LABELS).map(([key, label]) => ({ key, label })),
    defaultSplit: cfg.DEFAULT_INCENTIVE_SPLIT,
    acceptWindowHours: ACCEPT_WINDOW_HOURS,
    workflows,
    templates,
    taskTypes: types.filter(Boolean).sort(),
    // The HRMS events a template can be wired to, so the template form offers
    // the real list rather than a copy of it that goes stale.
    triggers: require('../services/taskEvents').TRIGGERS,
    can: {
      manage: access.canManage(req.user),
      configure: access.canConfigure(req.user),
    },
  });
});

module.exports = {
  listTasks,
  taskBoard,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  changeStatus,
  acceptTask,
  declineTask,
  startTask,
  setChecklistItem,
  setProgress,
  addAssignee,
  removeAssignee,
  handoverTask,
  listMyTasks,
  myTaskSummary,
  bulkAction,
  taskMeta,
  // Shared with the other task controllers and the workers.
  buildAssignees,
  resolveCompany,
  decorate,
  readPosition,
  onCompleted,
  USER_FIELDS,
};
