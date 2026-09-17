/**
 * Who may see and touch which tasks (section 36).
 *
 * The module's whole permission story is here, and it is deliberately built out
 * of the portal's EXISTING rules rather than a second system of its own:
 *
 *   - `tasks.manage`   — the capability that already existed. Create, edit,
 *                        assign, reassign, delete, and see every task inside the
 *                        company wall.
 *   - `tasks.workflow` — ONE new capability, for workflows, templates and
 *                        recurrence. Its own key for the same reason
 *                        `leaveHierarchy.manage` is its own key: running today's
 *                        tasks and deciding how every future task is routed are
 *                        different jobs, and the second is a standing decision.
 *   - IDENTITY         — everything else. You may act on a task because you are
 *                        ON it: its assignee, its supervisor, its manager, its
 *                        creator, or an approver the workflow is waiting on.
 *                        Nothing has to be granted for that, which is what lets
 *                        an ordinary supervisor run their team's work without
 *                        being made an administrator.
 *   - THE COMPANY WALL — utils/employeeScope, unchanged and unbypassed.
 *
 * The spec's list (TASK_CREATE, TASK_VIEW_ALL, TASK_APPROVE …) maps onto those
 * four; inventing eighteen new stored permission keys would be the "second
 * independent permission system" section 36 forbids.
 */
const mongoose = require('mongoose');
const Task = require('../models/Task');
const EmployeeProfile = require('../models/EmployeeProfile');
const { hasPermission } = require('../middleware/authMiddleware');
const { allowedUserIds, viewerCompanyScope } = require('../utils/employeeScope');
const { httpError } = require('./taskEngine');

/** May this account administer tasks at all? */
const canManage = (user) => hasPermission(user, 'tasks.manage');

/** May this account design workflows, templates and recurring schedules? */
const canConfigure = (user) => hasPermission(user, 'tasks.workflow');

/**
 * The filter fragment restricting a query to tasks this viewer may SEE.
 *
 * Three widths, narrowest first:
 *   an administrator  → every task inside their company wall;
 *   everybody else    → tasks they are on, supervise, manage, created, or are
 *                       being asked to approve;
 *   plus, for a Manager → their direct reports' tasks (section 27's "Team
 *                       Tasks"), because a line manager is answerable for work
 *                       they were not personally named on.
 *
 * Returns a fragment to spread into a filter, never a whole filter, so callers
 * can combine it with their own conditions.
 *
 * @param {import('express').Request} req
 * @returns {Promise<object>}
 */
async function visibilityFilter(req) {
  const user = req.user;

  if (canManage(user)) {
    // The company wall still applies. `assignedTo` is a User id, which is what
    // scopeUserField narrows — and unassigned tasks carry no people-data, so
    // they stay visible to a walled viewer rather than vanishing.
    const ids = await allowedUserIds(req);
    if (!ids) return {};
    const scope = viewerCompanyScope(req);
    const or = [
      { assignedTo: { $in: ids } },
      { 'assignees.user': { $in: ids } },
      { createdBy: { $in: ids } },
    ];
    // A task nobody is on belongs to nobody's company; a non-exec viewer (who
    // already sees people with no company) sees it too.
    if (!scope || scope.includeUnassigned) or.push({ assignedTo: null });
    return { $or: or };
  }

  const me = user._id;
  const or = [
    { assignedTo: me },
    { 'assignees.user': me },
    { supervisor: me },
    { manager: me },
    { createdBy: me },
    { watchers: me },
    { pendingApprovers: me },
  ];

  // A line manager sees their team's work whether or not they were named on it.
  const reports = await directReportUserIds(me);
  if (reports.length) {
    or.push({ assignedTo: { $in: reports } }, { 'assignees.user': { $in: reports } });
  }

  return { $or: or };
}

/**
 * The User ids of this person's direct reports.
 * Memoised per call site by the caller when it matters; one indexed query.
 * @param {*} userId
 * @returns {Promise<Array>}
 */
async function directReportUserIds(userId) {
  const profiles = await EmployeeProfile.find({ reportingManager: userId })
    .select('user')
    .lean();
  return profiles.map((p) => p.user).filter(Boolean);
}

/**
 * Load a task the requester is entitled to see, or refuse.
 *
 * Every per-task route starts here, so "can I see this?" is answered in one
 * place and a route added later cannot forget to ask.
 *
 * @param {import('express').Request} req
 * @param {string} id
 * @param {object} [opts]
 * @param {boolean} [opts.lean]
 * @param {boolean} [opts.populate]
 * @returns {Promise<object>} the Task
 * @throws {Error} 404 when missing, 403 when out of view
 */
async function loadVisibleTask(req, id, opts = {}) {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'That task does not exist.');

  let query = Task.findById(id);
  if (opts.populate !== false) {
    query = query
      .populate('assignedTo', 'firstName lastName email role photo')
      .populate('assignees.user', 'firstName lastName email role photo')
      .populate('supervisor', 'firstName lastName email role')
      .populate('manager', 'firstName lastName email role')
      .populate('createdBy', 'firstName lastName email role')
      .populate('project', 'name status');
  }
  if (opts.lean) query = query.lean();

  const task = await query;
  if (!task) throw httpError(404, 'That task does not exist.');

  if (!(await canSee(req, task))) {
    // Deliberately the same sentence a missing task gets. Whether a task exists
    // is itself information, and somebody probing ids should not learn it.
    throw httpError(404, 'That task does not exist.');
  }
  return task;
}

/**
 * May this viewer see this already-loaded task?
 * @param {import('express').Request} req
 * @param {object} task
 * @returns {Promise<boolean>}
 */
async function canSee(req, task) {
  const user = req.user;
  const uid = String(user._id);

  const named = String(task.assignedTo?._id || task.assignedTo || '') === uid
    || (task.assignees || []).some((a) => String(a.user?._id || a.user || '') === uid)
    || String(task.supervisor?._id || task.supervisor || '') === uid
    || String(task.manager?._id || task.manager || '') === uid
    || String(task.createdBy?._id || task.createdBy || '') === uid
    || (task.watchers || []).some((w) => String(w?._id || w) === uid)
    || (task.pendingApprovers || []).some((w) => String(w?._id || w) === uid);
  if (named) return true;

  if (canManage(user)) {
    // Inside the wall?
    const ids = await allowedUserIds(req);
    if (!ids) return true;
    const owner = String(task.assignedTo?._id || task.assignedTo || '');
    if (!owner) return true; // belongs to nobody's company
    return ids.includes(owner);
  }

  // A line manager sees their reports' tasks.
  const reports = (await directReportUserIds(user._id)).map(String);
  if (!reports.length) return false;
  const owner = String(task.assignedTo?._id || task.assignedTo || '');
  return reports.includes(owner)
    || (task.assignees || []).some((a) => reports.includes(String(a.user?._id || a.user || '')));
}

/**
 * Refuse anybody who is not entitled to EDIT a task's substance — its title,
 * dates, requirements, workflow or incentive.
 *
 * Narrower than seeing it and wider than `tasks.manage`: the person who created
 * a task, and the supervisor answerable for it, may change it. An assignee may
 * not — their part is doing the work, and a task whose own assignee can move its
 * deadline is not a deadline.
 *
 * @param {import('express').Request} req
 * @param {object} task
 * @throws {Error} 403
 */
function assertCanEdit(req, task) {
  const user = req.user;
  const uid = String(user._id);
  if (canManage(user)) return;
  if (String(task.createdBy?._id || task.createdBy || '') === uid) return;
  if (String(task.supervisor?._id || task.supervisor || '') === uid) return;
  if (String(task.manager?._id || task.manager || '') === uid) return;
  throw httpError(403, 'Only the person who set this task, its supervisor, or somebody who manages tasks can change it.');
}

/**
 * Refuse anybody who may not REVIEW — approve, reject, extend, escalate.
 * @param {import('express').Request} req
 * @param {object} task
 * @throws {Error} 403
 */
function assertCanReview(req, task) {
  const user = req.user;
  const uid = String(user._id);
  if (canManage(user)) return;
  if (String(task.supervisor?._id || task.supervisor || '') === uid) return;
  if (String(task.manager?._id || task.manager || '') === uid) return;
  if (String(task.createdBy?._id || task.createdBy || '') === uid) return;
  if ((task.pendingApprovers || []).some((w) => String(w?._id || w) === uid)) return;
  throw httpError(403, 'Only this task\'s supervisor, its reviewer, or somebody who manages tasks can decide it.');
}

/** Refuse anybody who is not on the task as somebody who does the work. */
function assertIsAssignee(req, task) {
  if (task.isAssignee ? task.isAssignee(req.user._id) : false) return;
  throw httpError(403, 'This task is not assigned to you.');
}

/**
 * Everybody who should hear that something happened on this task, split by
 * which portal they read it in.
 *
 * Used by nearly every notification in the module, so the answer to "who cares
 * about this task" is given once rather than assembled differently in eight
 * handlers.
 *
 * @param {object} task
 * @returns {{assignees: Array, reviewers: Array}}
 */
function audienceOf(task) {
  const id = (v) => (v && (v._id || v)) || null;
  const assignees = [
    ...(task.assignees || []).map((a) => id(a.user)),
    id(task.assignedTo),
  ].filter(Boolean);

  const reviewers = [
    id(task.supervisor),
    id(task.manager),
    id(task.createdBy),
    ...(task.pendingApprovers || []).map(id),
    ...(task.watchers || []).map(id),
  ].filter(Boolean);

  const dedupe = (list) => [...new Map(list.map((x) => [String(x), x])).values()];
  return { assignees: dedupe(assignees), reviewers: dedupe(reviewers) };
}

/**
 * The fallback bench for a task whose creator has left or was never recorded.
 *
 * An orphaned task's progress should still reach somebody rather than nobody —
 * and the bench is walled to the task's own company, so another company's HR
 * never hears about their people.
 * @param {object} task
 * @param {*} companyId
 * @returns {Promise<Array>}
 */
async function managerBench(task, companyId) {
  const { usersHoldingAny, scopeRecipientsToCompany } = require('./audience');
  const ids = await usersHoldingAny('tasks.manage');
  return scopeRecipientsToCompany(ids, companyId || task.company);
}

module.exports = {
  canManage,
  canConfigure,
  visibilityFilter,
  directReportUserIds,
  loadVisibleTask,
  canSee,
  assertCanEdit,
  assertCanReview,
  assertIsAssignee,
  audienceOf,
  managerBench,
};
