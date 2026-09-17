/**
 * The workflow runtime (sections 6–7).
 *
 * A workflow is a list of steps. This file is what makes that list DO something:
 * it copies a published version onto a task, works out who each step is waiting
 * on at the moment the step opens, advances the task as decisions come in, and
 * handles the three shapes the spec asks for — sequential, parallel and
 * conditional — out of that single list rather than out of three features.
 *
 *   SEQUENTIAL  steps run in `order`, one at a time.
 *   PARALLEL    steps sharing a `parallelGroup` open together and the group
 *               finishes on its `join` rule: all / any / majority.
 *   MIXED       a parallel group followed by an ordinary step. Nothing extra —
 *               it is the two above in one list.
 *   CONDITIONAL a step of type 'condition' tests a field of the task and names
 *               the step to jump to for true and for false.
 *
 * THE TASK RUNS A COPY, NOT THE WORKFLOW. `start()` writes the version's steps
 * onto Task.workflowSteps and never reads the Workflow document again. That is
 * what section 7 ("do not allow modification of an active workflow version to
 * retroactively change existing task instances") and section 53 ("the workflow
 * version used by an existing task must remain immutable") actually require, and
 * it means a workflow can be edited, republished or deactivated with no effect
 * whatsoever on work already under way.
 *
 * ACTORS ARE RESOLVED LATE. Who acts on a step is worked out when the step
 * OPENS, not when the task starts — a reporting line that changes mid-task
 * should be honoured, and a named approver who has since left should not hold up
 * every task on the route. Once resolved they are frozen onto the step, so the
 * decision belongs to the person who was actually asked.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const Workflow = require('../models/Workflow');
const { usersHoldingAny } = require('./audience');
const { logActivity, httpError, fullName } = require('./taskEngine');
const taskNotify = require('./taskNotify');

// ===== Copying a version onto a task =====

/**
 * Put a workflow onto a task and open its first step.
 *
 * @param {object} task - a Task document (mutated; the caller saves)
 * @param {*} workflowId
 * @param {object} [opts]
 * @param {number} [opts.version] - a specific published version; default active
 * @returns {Promise<object>} the task
 * @throws {Error} when the workflow does not exist or has nothing published
 */
async function start(task, workflowId, opts = {}) {
  const wf = await Workflow.findById(workflowId);
  if (!wf) throw httpError(400, 'That workflow does not exist.');

  const version = opts.version || wf.activeVersion;
  if (!version) {
    throw httpError(400, `"${wf.name}" has no published version yet, so nothing can be run through it.`);
  }
  const snapshot = (wf.versions || []).find((v) => v.version === version);
  if (!snapshot || !snapshot.steps.length) {
    throw httpError(400, `Version ${version} of "${wf.name}" has no steps.`);
  }

  task.workflowRef = wf._id;
  task.workflowVersion = version;
  task.workflowName = wf.name;
  task.workflowSteps = snapshot.steps.map((s) => ({
    key: s.key,
    name: s.name,
    type: s.type,
    order: s.order,
    parallelGroup: s.parallelGroup || null,
    join: s.join || 'all',
    assigneeRule: s.assigneeRule ? JSON.parse(JSON.stringify(s.assigneeRule)) : {},
    actors: [],
    status: 'Waiting',
    optional: !!s.optional,
    slaHours: s.slaHours,
    waitMinutes: s.waitMinutes,
    condition: s.condition ? JSON.parse(JSON.stringify(s.condition)) : undefined,
    next: s.next || null,
    onReject: s.onReject || 'sendBack',
  }));
  task.currentStepKey = null;
  task.pendingApprovers = [];

  await logActivity({
    task: task._id,
    kind: 'workflowStarted',
    system: true,
    message: `Started workflow "${wf.name}" (version ${version})`,
    refModel: 'Workflow',
    refId: wf._id,
  });

  return task;
}

// ===== Resolving who acts =====

/**
 * The people a step is waiting on, resolved now.
 *
 * Returns a list that may be empty, and an empty list is a REAL ANSWER the
 * caller has to handle — a step addressed to a role nobody holds, or to a
 * reporting manager who has left, would otherwise wait forever. `advance` skips
 * an optional step it cannot address and escalates a mandatory one rather than
 * stalling in silence.
 *
 * @param {object} task
 * @param {object} step - a step on the task (not on the workflow)
 * @returns {Promise<Array<{_id:*, firstName:string, lastName:string}>>}
 */
async function resolveActors(task, step) {
  const rule = step.assigneeRule || {};
  const kind = rule.kind || 'user';

  /** Load active users by id, dropping anyone who has left. */
  const activeUsers = async (ids) => {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return [];
    return User.find({ _id: { $in: list }, isActive: true })
      .select('firstName lastName role email')
      .lean();
  };

  /** The primary assignee's employee profile — where reporting lines live. */
  const primaryProfile = async () => {
    if (!task.assignedTo) return null;
    return EmployeeProfile.findOne({ user: task.assignedTo })
      .select('reportingManager hrPartner department company')
      .lean();
  };

  switch (kind) {
    case 'user':
      return activeUsers(rule.users);

    case 'role': {
      const roles = (rule.roles || []).filter(Boolean);
      if (!roles.length) return [];
      const filter = { role: { $in: roles }, isActive: true };
      const found = await User.find(filter).select('firstName lastName role').lean();
      return scopeToCompany(found, task.company);
    }

    case 'permission': {
      if (!rule.permission) return [];
      const ids = await usersHoldingAny(rule.permission);
      const found = await activeUsers(ids);
      return scopeToCompany(found, task.company);
    }

    case 'supervisor':
      return activeUsers([task.supervisor]);

    case 'manager':
      return activeUsers([task.manager]);

    case 'creator':
      return activeUsers([task.createdBy]);

    case 'reportingManager': {
      const prof = await primaryProfile();
      return activeUsers([prof && prof.reportingManager]);
    }

    case 'hrPartner': {
      const prof = await primaryProfile();
      return activeUsers([prof && prof.hrPartner]);
    }

    case 'department': {
      const dept = rule.department || task.department;
      if (!dept) return [];
      // The people in that department who hold `tasks.manage` — a department's
      // approver is whoever runs tasks for it, not everybody who works in it.
      const [managers, profiles] = await Promise.all([
        usersHoldingAny('tasks.manage'),
        EmployeeProfile.find({ department: dept }).select('user').lean(),
      ]);
      const inDept = new Set(profiles.map((p) => String(p.user)));
      return activeUsers(managers.filter((id) => inDept.has(String(id))));
    }

    default:
      return activeUsers(rule.users);
  }
}

/**
 * Keep only the people inside the task's company.
 *
 * The company wall applies to approvals as much as to lists: a step addressed to
 * "every HR Manager" must not put another company's HR on a task about somebody
 * they may not even see. A task with no company (the legacy rows, and anything
 * genuinely shared) is not narrowed.
 * @param {Array} users
 * @param {*} companyId
 * @returns {Promise<Array>}
 */
async function scopeToCompany(users, companyId) {
  if (!companyId || !users.length) return users;
  const ids = users.map((u) => u._id);
  const [profiles, accounts] = await Promise.all([
    EmployeeProfile.find({ user: { $in: ids } }).select('user company').lean(),
    User.find({ _id: { $in: ids } }).select('role companies').lean(),
  ]);
  const profCompany = new Map(profiles.map((p) => [String(p.user), p.company ? String(p.company) : '']));
  const account = new Map(accounts.map((a) => [String(a._id), a]));
  const want = String(companyId);

  return users.filter((u) => {
    const acc = account.get(String(u._id));
    // The Backend sees everything; an exec sees the companies on their account,
    // and an exec with no list set is unrestricted. Same rule as
    // utils/employeeScope.viewerCompanyScope, applied to a recipient rather than
    // to a viewer.
    if (acc && acc.role === 'SuperAdmin') return true;
    if (acc && ['CEO', 'MD', 'God'].includes(acc.role)) {
      const own = (acc.companies || []).map(String);
      return own.length === 0 || own.includes(want);
    }
    const c = profCompany.get(String(u._id));
    // No company on their record: they belong to nobody else's, so they stay.
    return !c || c === want;
  });
}

// ===== Conditions =====

/**
 * Read a path off a task, including into its custom fields.
 *
 * 'customFields.amount' looks up the field whose `key` is 'amount' and returns
 * its value — which is what a person writing a condition means, and not what a
 * plain lodash-style path would find (the array index).
 * @param {object} task
 * @param {string} path
 * @returns {*}
 */
function readField(task, path) {
  if (!path) return undefined;
  if (path.startsWith('customFields.')) {
    const key = path.slice('customFields.'.length);
    const f = (task.customFields || []).find((x) => x.key === key);
    return f ? f.value : undefined;
  }
  return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), task);
}

/**
 * Evaluate a condition step against the task.
 *
 * Numeric comparisons coerce both sides, because a custom field arrives as
 * whatever the form sent — "60000" from a text input has to be greater than
 * 50000, or the spec's own example ("if amount > ₹50,000") silently takes the
 * wrong branch every time.
 * @param {object} task
 * @param {object} condition
 * @returns {boolean}
 */
function evaluateCondition(task, condition) {
  if (!condition || !condition.field) return false;
  const actual = readField(task, condition.field);
  const expected = condition.value;
  const num = (v) => {
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  };

  switch (condition.operator) {
    case 'eq': return String(actual ?? '') === String(expected ?? '');
    case 'ne': return String(actual ?? '') !== String(expected ?? '');
    case 'gt': return num(actual) > num(expected);
    case 'gte': return num(actual) >= num(expected);
    case 'lt': return num(actual) < num(expected);
    case 'lte': return num(actual) <= num(expected);
    case 'in': return (Array.isArray(expected) ? expected : String(expected || '').split(','))
      .map((v) => String(v).trim())
      .includes(String(actual ?? '').trim());
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'empty': return actual == null || actual === '' || (Array.isArray(actual) && !actual.length);
    case 'notEmpty': return !(actual == null || actual === '' || (Array.isArray(actual) && !actual.length));
    default: return false;
  }
}

// ===== Running =====

const stepByKey = (task, key) => (task.workflowSteps || []).find((s) => s.key === key);

/** Steps in a parallel group, or just this one when it is not in a group. */
function groupOf(task, step) {
  if (!step.parallelGroup) return [step];
  return (task.workflowSteps || []).filter((s) => s.parallelGroup === step.parallelGroup);
}

/** The step after this one, by explicit `next` or by `order`. */
function nextStepOf(task, step) {
  if (step.next) return stepByKey(task, step.next);
  const ordered = [...(task.workflowSteps || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  // Leaving a parallel group means leaving ALL of it, so skip past the siblings.
  const idx = ordered.findIndex((s) => s.key === step.key);
  for (let i = idx + 1; i < ordered.length; i += 1) {
    if (step.parallelGroup && ordered[i].parallelGroup === step.parallelGroup) continue;
    return ordered[i];
  }
  return null;
}

/** The first step of the workflow, by `order`. */
function firstStepOf(task) {
  const ordered = [...(task.workflowSteps || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  return ordered[0] || null;
}

/**
 * Open a step (and its parallel siblings), resolving and freezing their actors.
 *
 * Returns what the caller has to act on: the steps now open, who they are
 * waiting on, and whether the workflow moved past them on its own — a condition
 * and a notify step both decide themselves and hand straight on.
 *
 * @param {object} task - mutated, not saved
 * @param {object|null} step
 * @returns {Promise<{opened:Array, done:boolean, rejected:boolean}>}
 */
async function open(task, step) {
  if (!step) {
    task.currentStepKey = null;
    task.pendingApprovers = [];
    return { opened: [], done: true, rejected: false };
  }

  // --- a condition decides itself ---
  if (step.type === 'condition') {
    const passed = evaluateCondition(task, step.condition);
    step.status = 'Skipped';
    step.completedAt = new Date();
    await logActivity({
      task: task._id,
      kind: 'stepSkipped',
      system: true,
      message: `"${step.name}" evaluated ${passed ? 'true' : 'false'}`,
      field: step.condition && step.condition.field,
      to: passed ? 'true' : 'false',
    });
    const targetKey = passed ? step.condition?.onTrue : step.condition?.onFalse;
    const target = targetKey ? stepByKey(task, targetKey) : nextStepOf(task, step);
    return open(task, target || null);
  }

  // --- a notification step tells people and hands on ---
  if (step.type === 'notify') {
    const people = await resolveActors(task, step);
    step.status = 'Done';
    step.openedAt = new Date();
    step.completedAt = new Date();
    if (people.length) {
      taskNotify.approvalNeeded(task, people.map((p) => p._id), step).catch(() => {});
    }
    await logActivity({
      task: task._id,
      kind: 'stepDecided',
      system: true,
      message: `"${step.name}" notified ${people.length} ${people.length === 1 ? 'person' : 'people'}`,
    });
    return open(task, nextStepOf(task, step));
  }

  // --- a wait step holds, and the reminder worker wakes it ---
  if (step.type === 'wait') {
    step.status = 'Pending';
    step.openedAt = new Date();
    step.dueAt = new Date(Date.now() + (step.waitMinutes || 0) * 60000);
    task.currentStepKey = step.key;
    task.pendingApprovers = [];
    return { opened: [step], done: false, rejected: false };
  }

  // --- an ordinary step, possibly one of several running together ---
  const siblings = groupOf(task, step);
  const opened = [];
  const waitingOn = [];
  const now = new Date();

  for (const s of siblings) {
    if (s.status !== 'Waiting') continue;
    const people = await resolveActors(task, s);

    if (!people.length) {
      // Nobody to ask. An optional step is skipped; a mandatory one is recorded
      // as unaddressable and skipped too rather than stalling the task forever —
      // but LOUDLY, so somebody can fix the workflow.
      s.status = 'Skipped';
      s.completedAt = now;
      await logActivity({
        task: task._id,
        kind: 'stepSkipped',
        system: true,
        message: s.optional
          ? `"${s.name}" skipped — nobody is assigned to it`
          : `"${s.name}" SKIPPED — no active user matched its assignee rule. The workflow needs fixing.`,
      });
      continue;
    }

    s.status = 'Pending';
    s.openedAt = now;
    if (s.slaHours) s.dueAt = new Date(now.getTime() + s.slaHours * 3600000);
    s.actors = people.map((p) => ({
      user: p._id,
      name: fullName(p),
      decision: null,
    }));
    opened.push(s);
    waitingOn.push(...people);

    await logActivity({
      task: task._id,
      kind: 'stepOpened',
      system: true,
      message: `"${s.name}" is waiting on ${people.map(fullName).join(', ')}`,
    });
  }

  if (!opened.length) {
    // Every step in this group was skipped — carry on to whatever follows.
    return open(task, nextStepOf(task, step));
  }

  task.currentStepKey = opened[0].key;
  task.pendingApprovers = [...new Set(waitingOn.map((p) => String(p._id)))]
    .map((id) => new mongoose.Types.ObjectId(id));

  for (const s of opened) {
    taskNotify.approvalNeeded(task, s.actors.map((a) => a.user), s).catch(() => {});
  }

  return { opened, done: false, rejected: false };
}

/** Begin the workflow at its first step. */
function begin(task) {
  return open(task, firstStepOf(task));
}

/**
 * Has a parallel group finished, given its join rule?
 * @param {Array} steps - the group
 * @returns {{finished:boolean, rejected:boolean}}
 */
function groupSettled(steps) {
  const live = steps.filter((s) => s.status !== 'Skipped');
  if (!live.length) return { finished: true, rejected: false };

  const decided = live.filter((s) => ['Approved', 'Rejected', 'Done'].includes(s.status));
  const rejected = live.filter((s) => s.status === 'Rejected');
  const approved = live.filter((s) => ['Approved', 'Done'].includes(s.status));
  const join = live[0].join || 'all';

  if (join === 'any') {
    // One yes is enough; it takes ALL of them saying no to fail.
    if (approved.length >= 1) return { finished: true, rejected: false };
    if (rejected.length === live.length) return { finished: true, rejected: true };
    return { finished: false, rejected: false };
  }

  if (join === 'majority') {
    const need = Math.floor(live.length / 2) + 1;
    if (approved.length >= need) return { finished: true, rejected: false };
    if (rejected.length >= need) return { finished: true, rejected: true };
    return { finished: false, rejected: false };
  }

  // 'all' — everyone must decide, and any single no fails the group.
  if (rejected.length) return { finished: true, rejected: true };
  return { finished: decided.length === live.length, rejected: false };
}

/**
 * Record one person's decision on the step they were asked about, and move the
 * workflow on if that settles it.
 *
 * @param {object} task - mutated, not saved
 * @param {string} stepKey
 * @param {object} user - req.user
 * @param {'approved'|'rejected'|'done'} decision
 * @param {string} [note]
 * @returns {Promise<{settled:boolean, rejected:boolean, done:boolean, step:object}>}
 * @throws {Error} when this person was not asked, or has already answered
 */
async function decide(task, stepKey, user, decision, note) {
  const step = stepByKey(task, stepKey);
  if (!step) throw httpError(400, 'That step is not part of this task.');
  if (step.status !== 'Pending') {
    throw httpError(409, `"${step.name}" is not waiting for a decision — it is already ${String(step.status).toLowerCase()}.`);
  }

  const mine = (step.actors || []).find((a) => String(a.user) === String(user._id));
  if (!mine) throw httpError(403, `"${step.name}" is not waiting on you.`);
  if (mine.decision) {
    throw httpError(409, `You have already ${mine.decision} "${step.name}".`);
  }

  mine.decision = decision;
  mine.note = note ? String(note).slice(0, 1000) : undefined;
  mine.decidedAt = new Date();

  // Does the STEP now have its answer? An approval addressed to several people
  // is satisfied by one of them unless the rule said 'all'.
  const quorum = (step.assigneeRule && step.assigneeRule.quorum) || 'any';
  const answered = (step.actors || []).filter((a) => a.decision);
  const anyRejected = (step.actors || []).some((a) => a.decision === 'rejected');

  let stepSettled = false;
  if (anyRejected) {
    step.status = 'Rejected';
    stepSettled = true;
  } else if (quorum === 'all') {
    if (answered.length === (step.actors || []).length) {
      step.status = decision === 'done' ? 'Done' : 'Approved';
      stepSettled = true;
    }
  } else {
    step.status = decision === 'done' ? 'Done' : 'Approved';
    stepSettled = true;
  }
  if (stepSettled) step.completedAt = new Date();

  await logActivity({
    task: task._id,
    kind: 'stepDecided',
    by: user,
    message: `${fullName(user)} ${decision} "${step.name}"`,
    note,
    field: step.key,
    to: step.status,
  });

  if (!stepSettled) {
    // Still waiting on the rest of this step's people.
    task.pendingApprovers = (step.actors || [])
      .filter((a) => !a.decision)
      .map((a) => a.user);
    return { settled: false, rejected: false, done: false, step };
  }

  // Does the GROUP now have its answer?
  const group = groupOf(task, step);
  const settled = groupSettled(group);
  if (!settled.finished) {
    // Other steps in the parallel group are still open — keep the inbox honest.
    task.pendingApprovers = group
      .filter((s) => s.status === 'Pending')
      .flatMap((s) => (s.actors || []).filter((a) => !a.decision).map((a) => a.user));
    return { settled: false, rejected: false, done: false, step };
  }

  if (settled.rejected) {
    // Close whatever is still open in the group — the decision has been made.
    for (const s of group) {
      if (s.status === 'Pending') { s.status = 'Skipped'; s.completedAt = new Date(); }
    }
    task.pendingApprovers = [];
    return { settled: true, rejected: true, done: false, step };
  }

  const result = await open(task, nextStepOf(task, step));
  return { settled: true, rejected: false, done: result.done, step };
}

/**
 * Put the workflow back to the beginning of the step that sent the task back, so
 * a resubmission is reviewed again rather than sailing past.
 *
 * Called when a rejected task is resubmitted. The steps AFTER the rejecting one
 * are untouched — they never ran.
 * @param {object} task - mutated, not saved
 * @returns {Promise<object>} the reopened step, or null
 */
async function reopenAfterResubmission(task) {
  const rejected = (task.workflowSteps || [])
    .filter((s) => s.status === 'Rejected')
    .sort((a, b) => (b.order || 0) - (a.order || 0))[0];
  if (!rejected) return null;

  const group = groupOf(task, rejected);
  for (const s of group) {
    s.status = 'Waiting';
    s.actors = [];
    s.openedAt = undefined;
    s.dueAt = undefined;
    s.completedAt = undefined;
  }
  const result = await open(task, rejected);
  return result.opened[0] || null;
}

/** Is there any step left to run? */
function hasPendingSteps(task) {
  return (task.workflowSteps || []).some((s) => s.status === 'Pending' || s.status === 'Waiting');
}

/**
 * A summary of the route for the clients — what is done, what is open, what is
 * still ahead. Keeps the progress rail on the detail page from having to know
 * anything about parallel groups.
 * @param {object} task
 * @returns {Array<object>}
 */
function outline(task) {
  return [...(task.workflowSteps || [])]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((s) => ({
      key: s.key,
      name: s.name,
      type: s.type,
      status: s.status,
      parallelGroup: s.parallelGroup,
      join: s.join,
      optional: s.optional,
      openedAt: s.openedAt,
      dueAt: s.dueAt,
      completedAt: s.completedAt,
      actors: (s.actors || []).map((a) => ({
        user: a.user, name: a.name, decision: a.decision, decidedAt: a.decidedAt, note: a.note,
      })),
    }));
}

module.exports = {
  start,
  begin,
  open,
  decide,
  resolveActors,
  evaluateCondition,
  readField,
  reopenAfterResubmission,
  hasPendingSteps,
  groupSettled,
  nextStepOf,
  firstStepOf,
  stepByKey,
  outline,
};
