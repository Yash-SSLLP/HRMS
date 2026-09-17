/**
 * The task state machine, and the only place a task's status is allowed to move.
 *
 * Every path that changes a task — the admin form, an employee accepting one on
 * their phone, a reviewer approving, the reminder worker escalating, the
 * workflow advancing itself — comes through `transition()`. That is what makes
 * four promises hold at once, none of which can be kept by a handler remembering
 * to be careful:
 *
 *   1. ONLY LEGAL MOVES HAPPEN. The table in config/taskWorkflow.js is the whole
 *      truth about what may follow what, and who may do it.
 *   2. TWO PEOPLE CANNOT BOTH WIN (section 52). The write is a single
 *      conditional update keyed on the status we believe the task is in. If
 *      somebody moved it first, the update matches nothing and the second caller
 *      is told so, rather than overwriting a decision that has already been made
 *      and notified.
 *   3. NOTHING MOVES WITHOUT A LINE IN THE TRAIL (section 30). The activity row
 *      is written by the same function that makes the move.
 *   4. TIMESTAMPS ARE OURS (section 37). `completedAt`, `approvedAt` and friends
 *      are stamped here from the server clock; a client may not send them.
 *
 * WHAT THIS FILE DOES NOT DO. It does not decide what happens NEXT — advancing a
 * workflow, evaluating an incentive, sending notifications. Those live in
 * services/taskWorkflow.js, services/taskIncentive.js and services/taskNotify.js
 * and are called by the controller after a move succeeds, so the engine has no
 * opinion about modules above it and cannot deadlock against them.
 */
const Task = require('../models/Task');
const TaskActivity = require('../models/TaskActivity');
const WorkLocation = require('../models/WorkLocation');
const EmployeeProfile = require('../models/EmployeeProfile');
const { haversineMeters } = require('../utils/geo');
const {
  transitionRule,
  transitionNeedsReason,
  normaliseStatus,
  statusLabel,
  isTerminal,
  REQUIREMENT_LABELS,
} = require('../config/taskWorkflow');
const { hasPermission } = require('../middleware/authMiddleware');

// ===== Errors =====

/**
 * An error with an HTTP status on it, the shape the central errorHandler and
 * every controller in this repo already understand.
 * @param {number} status
 * @param {string} message - shown to the user, so it is a sentence
 * @returns {Error}
 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  return err;
}

// ===== Who is this person, to this task? =====

/**
 * The parts this user plays on this task, in the transition table's vocabulary.
 *
 * Several at once is normal and correct: an HR Manager who assigned a task to
 * themselves is both 'assignee' and 'admin', and either hat is enough for a move
 * that accepts it. 'system' is never returned — only the engine's own callers
 * pass it, and they pass it explicitly.
 *
 * @param {object} task - a Task document
 * @param {object} user - req.user
 * @returns {string[]} some of 'assignee' | 'reviewer' | 'admin'
 */
function actorRoles(task, user) {
  const roles = [];
  if (!task || !user) return roles;
  const uid = String(user._id);

  if (task.isAssignee(uid)) roles.push('assignee');
  if (task.isReviewer(uid)) roles.push('reviewer');

  // The creator reviews their own task by default — they handed it over and are
  // the person the assignee reports back to. This is what makes the module work
  // for a supervisor who holds no capability at all.
  if (String(task.createdBy || '') === uid && !roles.includes('reviewer')) roles.push('reviewer');

  if (hasPermission(user, 'tasks.manage')) roles.push('admin');

  return roles;
}

/**
 * Would this move be allowed, and by this person? Throws when not.
 *
 * Deliberately throws rather than returning a boolean: the REASON matters — "you
 * cannot approve your own submission" and "that task is already completed" send
 * the person to different places — and a caller that forgets to check a boolean
 * fails open, while one that forgets to catch fails closed.
 *
 * @param {object} task
 * @param {string} to - target status
 * @param {object|null} user - req.user, or null for a system move
 * @param {object} [opts]
 * @param {string} [opts.note] - the remark accompanying the move
 * @param {boolean} [opts.system] - a move the engine is making by itself
 * @returns {{from:string, to:string, rule:object, actor:string}}
 * @throws {Error} with .status
 */
function assertCanTransition(task, to, user, opts = {}) {
  const from = normaliseStatus(task.status) || task.status;
  const target = normaliseStatus(to);
  if (!target) throw httpError(400, `"${to}" is not a task status.`);

  if (from === target) {
    // Not an error worth shouting about — a double-tapped button, an app
    // retrying. The caller decides what to do with it; see `transition`.
    throw httpError(409, `This task is already ${statusLabel(target).toLowerCase()}.`);
  }

  const rule = transitionRule(from, target);
  if (!rule) {
    throw httpError(
      400,
      `A task that is ${statusLabel(from).toLowerCase()} cannot be marked ${statusLabel(target).toLowerCase()}.`
    );
  }

  if (opts.system) {
    if (!rule.actors.includes('system') && !rule.actors.includes('admin')) {
      throw httpError(400, `${statusLabel(from)} → ${statusLabel(target)} is not a move the system makes.`);
    }
    return { from, to: target, rule, actor: 'system' };
  }

  if (!user) throw httpError(401, 'Sign in to change a task.');

  const mine = actorRoles(task, user);
  const allowed = rule.actors.filter((a) => a !== 'system');
  const actor = allowed.find((a) => mine.includes(a));
  if (!actor) {
    throw httpError(403, refusalFor(allowed, statusLabel(target)));
  }

  // NOBODY REVIEWS THEIR OWN WORK. An approval or a rejection by the person who
  // submitted is not a decision, and the rest of this portal refuses the same
  // thing everywhere (utils/employeeScope.assertNotOwnRequest). The exception is
  // an admin acting on a task they are also assigned — a one-person department
  // has nobody else, and the trail records who did it either way.
  const reviewMoves = ['APPROVED', 'REJECTED', 'UNDER_REVIEW'];
  if (reviewMoves.includes(target) && actor !== 'admin' && task.isAssignee(user._id)) {
    throw httpError(403, 'You cannot review your own submission. It needs somebody else on the task.');
  }

  if (transitionNeedsReason(from, target) && !String(opts.note || '').trim()) {
    throw httpError(400, `Say why before marking this task ${statusLabel(target).toLowerCase()}.`);
  }

  return { from, to: target, rule, actor };
}

/**
 * The sentence a refused move gets. Named after the people who COULD have made
 * it, because "you do not have permission" tells somebody nothing about who to
 * go and ask.
 * @param {string[]} allowed
 * @param {string} label
 * @returns {string}
 */
function refusalFor(allowed, label) {
  const who = {
    assignee: 'somebody the task is assigned to',
    reviewer: 'its supervisor or reviewer',
    admin: 'somebody who manages tasks',
  };
  const names = allowed.map((a) => who[a]).filter(Boolean);
  const list = names.length > 1
    ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
    : names[0] || 'somebody else';
  return `Only ${list} can mark this task ${label.toLowerCase()}.`;
}

// ===== The move itself =====

/**
 * Which lifecycle stamps a status sets when a task arrives at it. Server clock,
 * always. A stamp is written ONCE — a task sent back and resubmitted keeps the
 * time it was first submitted as well as gaining a new one, because
 * `submittedAt` answers "when did this arrive for review" and the submission
 * rows answer "how many times".
 */
const STAMPS = {
  ACCEPTED: 'acceptedAt',
  IN_PROGRESS: 'startedAt',
  SUBMITTED: 'submittedAt',
  APPROVED: 'approvedAt',
  COMPLETED: 'completedAt',
};

/** The activity verb for arriving at each status. */
const ACTIVITY_FOR = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  IN_PROGRESS: 'started',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'stepOpened',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  ON_HOLD: 'onHold',
  CANCELLED: 'cancelled',
};

/**
 * Move a task, atomically, and record that it happened.
 *
 * THE CONCURRENCY GUARD is the `status: from` clause in the filter. Two
 * reviewers pressing Approve in the same second both read the task as
 * UNDER_REVIEW and both call this; the first update matches and wins, the second
 * matches NOTHING and is told the task has already moved — rather than silently
 * writing the same status again, stamping a second `approvedAt`, and firing a
 * second set of notifications at everybody.
 *
 * @param {object} task - the Task document as the caller read it
 * @param {string} to - target status
 * @param {object|null} user - req.user, or null with opts.system
 * @param {object} [opts]
 * @param {string} [opts.note] - the remark; required for some moves
 * @param {boolean} [opts.system]
 * @param {object} [opts.set] - extra fields to write in the same update
 * @param {object} [opts.location] - captured position, when the task asks for one
 * @param {string} [opts.ip]
 * @param {string} [opts.message] - override the trail's sentence
 * @param {boolean} [opts.idempotent] - treat "already there" as success
 * @returns {Promise<object>} the updated Task document
 * @throws {Error} with .status
 */
async function transition(task, to, user, opts = {}) {
  let plan;
  try {
    plan = assertCanTransition(task, to, user, opts);
  } catch (err) {
    // A repeat of a move already made is a no-op for callers that say so — an
    // app retrying a request must not produce an error the user has to read.
    if (err.status === 409 && opts.idempotent) return task;
    throw err;
  }

  const { from, to: target } = plan;
  const now = new Date();

  const set = { status: target, ...(opts.set || {}) };
  const stamp = STAMPS[target];
  if (stamp && !task[stamp]) set[stamp] = now;
  if (target === 'COMPLETED' && !task.completedAt) set.completedAt = now;
  if (isTerminal(target)) set.closedAt = now;
  // A reason given with the move is the row's own explanation of its state, and
  // is what the list view shows beside a blocked or held task.
  if (opts.note && ['BLOCKED', 'ON_HOLD', 'CANCELLED', 'DECLINED', 'REJECTED'].includes(target)) {
    set.stateNote = String(opts.note).trim().slice(0, 1000);
  }
  // Leaving a stuck state clears the explanation for being stuck.
  if (['IN_PROGRESS', 'ACCEPTED', 'ASSIGNED'].includes(target) && task.stateNote) set.stateNote = '';
  if (target === 'REJECTED') set.rejectionCount = (task.rejectionCount || 0) + 1;

  const $push = {};
  if (opts.location && opts.location.lat != null) {
    $push['location.captured'] = {
      ...opts.location,
      event: opts.locationEvent || eventForStatus(target),
      user: user ? user._id : undefined,
      userName: user ? fullName(user) : undefined,
      at: now,
    };
  }

  const update = { $set: set };
  if (Object.keys($push).length) update.$push = $push;

  const updated = await Task.findOneAndUpdate(
    // `$in` with both vocabularies: an un-migrated row is still sitting on
    // 'Todo' in the database while the document we hold reads 'ASSIGNED',
    // because the pre-validate hook normalised it in memory. Matching on both
    // means the guard still works during the migration window instead of
    // refusing every move on a legacy row.
    { _id: task._id, status: { $in: legacyAliases(from) } },
    update,
    { new: true }
  );

  if (!updated) {
    // Somebody moved it first. Say what it is NOW, so the person knows whether
    // there is anything left for them to do.
    const current = await Task.findById(task._id).select('status').lean();
    const nowLabel = current ? statusLabel(normaliseStatus(current.status) || current.status) : 'changed';
    throw httpError(409, `Somebody else has already moved this task — it is now ${nowLabel.toLowerCase()}. Reload to see the latest.`);
  }

  await logActivity({
    task: updated._id,
    kind: ACTIVITY_FOR[target] || 'updated',
    by: user,
    system: opts.system,
    message: opts.message || defaultMessage(user, from, target, opts.system),
    note: opts.note,
    field: 'status',
    from,
    to: target,
    location: opts.location,
    ip: opts.ip,
  });

  return updated;
}

/** The status values a stored row could be holding for a given lifecycle state. */
function legacyAliases(status) {
  const { LEGACY_STATUS_MAP } = require('../config/taskWorkflow');
  const olds = Object.entries(LEGACY_STATUS_MAP)
    .filter(([, v]) => v === status)
    .map(([k]) => k);
  return [status, ...olds];
}

/** Which location-capture moment a status arrival corresponds to. */
function eventForStatus(status) {
  return ({
    ACCEPTED: 'accept',
    IN_PROGRESS: 'start',
    SUBMITTED: 'submit',
    APPROVED: 'approve',
    COMPLETED: 'complete',
  })[status] || 'start';
}

const fullName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Somebody';

/** "Amit submitted for review" — the trail's default sentence. */
function defaultMessage(user, from, to, system) {
  const who = system || !user ? 'The system' : fullName(user);
  const verbs = {
    ACCEPTED: 'accepted the task',
    DECLINED: 'declined the task',
    IN_PROGRESS: from === 'REJECTED' ? 'started work again' : 'started work',
    SUBMITTED: 'submitted for review',
    UNDER_REVIEW: 'began reviewing',
    APPROVED: 'approved the task',
    REJECTED: 'sent the task back',
    COMPLETED: 'completed the task',
    BLOCKED: 'marked the task blocked',
    ON_HOLD: 'put the task on hold',
    CANCELLED: 'cancelled the task',
    ASSIGNED: 'returned the task to assigned',
  };
  return `${who} ${verbs[to] || `moved the task to ${statusLabel(to)}`}`;
}

// ===== The trail =====

/**
 * Write one line of a task's history. Best-effort by design — a trail entry must
 * never fail the act it is describing, which is the same bargain the portal-wide
 * audit plugin makes.
 *
 * @param {object} input
 * @param {*} input.task - task id
 * @param {string} input.kind
 * @param {object|null} [input.by] - req.user
 * @param {boolean} [input.system]
 * @param {string} [input.message]
 * @param {string} [input.note]
 * @param {string} [input.field]
 * @param {*} [input.from]
 * @param {*} [input.to]
 * @param {string} [input.refModel]
 * @param {*} [input.refId]
 * @param {object} [input.location]
 * @param {string} [input.ip]
 * @returns {Promise<object|null>} the row, or null when it could not be written
 */
async function logActivity({
  task, kind, by, system, message, note, field, from, to, refModel, refId, location, ip,
}) {
  try {
    return await TaskActivity.create({
      task,
      kind,
      by: system ? undefined : (by && by._id),
      byName: system ? undefined : (by && fullName(by)),
      byRole: system ? undefined : (by && by.role),
      message: message ? String(message).slice(0, 600) : undefined,
      note: note ? String(note).slice(0, 2000) : undefined,
      field,
      from: from == null ? undefined : String(from),
      to: to == null ? undefined : String(to),
      refModel,
      refId,
      location: location && location.lat != null ? {
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy,
        address: location.address,
        distanceM: location.distanceM,
        insideFence: location.insideFence,
      } : undefined,
      ip,
      at: new Date(),
    });
  } catch (err) {
    console.error('Task activity not recorded:', err.message);
    return null;
  }
}

// ===== Geofence (section 16) =====

/**
 * Measure a position against the fence this task enforces, and refuse the act
 * when it falls outside one that is being enforced.
 *
 * WHICH FENCE. The task's own work location if it names one; otherwise the
 * primary assignee's assigned site (EmployeeProfile.workLocationRef), which is
 * how attendance already decides the same question. A task that enforces a fence
 * and can find neither is a configuration mistake, and it says so rather than
 * silently letting everything through.
 *
 * `enforceOn` and `captureOn` are independent: a task can record where somebody
 * was without refusing them, which is the common case.
 *
 * @param {object} task
 * @param {string} event - 'start' | 'submit' | 'complete'
 * @param {{lat:number,lng:number,accuracy:number,address:string}|null} position
 * @param {*} userId - who is acting, for resolving their site
 * @returns {Promise<object|null>} the position, annotated with distance and
 *   whether it was inside; null when the task captures nothing for this event
 * @throws {Error} 403 when the fence is enforced and the person is outside it
 */
async function checkGeofence(task, event, position, userId) {
  const cfg = task.location || {};
  const captures = (cfg.captureOn || []).includes(event);
  const enforces = (cfg.enforceOn || []).includes(event);
  if (!captures && !enforces) return null;

  if (!position || position.lat == null || position.lng == null) {
    if (!enforces) return null;
    throw httpError(400, 'This task needs your location, and the device did not provide one. Allow location access and try again.');
  }

  let site = null;
  if (cfg.workLocation) {
    site = await WorkLocation.findById(cfg.workLocation).lean();
  } else {
    const prof = await EmployeeProfile.findOne({ user: userId }).select('workLocationRef').lean();
    if (prof && prof.workLocationRef) site = await WorkLocation.findById(prof.workLocationRef).lean();
  }

  if (!site || site.lat == null || site.lng == null) {
    if (!enforces) return { ...position, at: new Date() };
    throw httpError(
      400,
      'This task must be done at a work site, but no site with a pin is set for it or for you. Ask HR to set one.'
    );
  }

  const radius = cfg.radiusM != null && cfg.radiusM > 0 ? cfg.radiusM : (site.radiusM || 200);
  const distanceM = haversineMeters({ lat: site.lat, lng: site.lng }, { lat: position.lat, lng: position.lng });
  const insideFence = distanceM != null && distanceM <= radius;

  const annotated = {
    ...position,
    at: new Date(),
    distanceM,
    insideFence,
    workLocation: site._id,
  };

  if (enforces && !insideFence) {
    await logActivity({
      task: task._id,
      kind: 'geofenceBlocked',
      by: { _id: userId },
      message: `Refused: ${distanceM} m from ${site.name}, outside the ${radius} m fence`,
      location: annotated,
    });
    throw httpError(
      403,
      `You need to be at ${site.name} to ${event} this task. You are about ${formatDistance(distanceM)} away.`
    );
  }

  return annotated;
}

/** "250 m" / "1.4 km" — a distance a person reads rather than parses. */
function formatDistance(m) {
  if (m == null) return 'some distance';
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

// ===== Submission requirements (section 12) =====

/**
 * Everything this task insists on that the submission does not have.
 *
 * Returned as sentences rather than a boolean so the person is told what to go
 * and do, all of it at once, instead of discovering one missing thing per
 * attempt. The client shows the same list as a checklist on the submission form
 * — but this is where it is ENFORCED, because a client-side check is a courtesy
 * and not a rule (section 37).
 *
 * @param {object} task
 * @param {object} payload - what is being submitted
 * @returns {string[]} empty when the submission is complete
 */
function missingRequirements(task, payload = {}) {
  const need = task.requirements || {};
  const missing = [];

  if (need.remarks && !String(payload.remarks || '').trim()) {
    missing.push('Remarks are required.');
  }

  if (need.checklist) {
    const items = task.checklist || [];
    const undone = items.filter((i) => i.mandatory !== false && !i.done);
    if (undone.length) {
      missing.push(undone.length === 1
        ? `One checklist item is not ticked: "${undone[0].text}".`
        : `${undone.length} checklist items are not ticked.`);
    }
  }

  const evidence = payload.evidence || [];
  const photos = evidence.filter((e) => e.kind === 'photo');
  const files = evidence.filter((e) => e.kind !== 'photo' && e.kind !== 'signature');

  if (need.photo) {
    const want = Math.max(1, need.minPhotos || 0);
    if (photos.length < want) {
      missing.push(want === 1
        ? 'A photo is required.'
        : `${want} photos are required — ${photos.length} attached.`);
    }
  }

  if (need.attachment) {
    const want = Math.max(1, need.minAttachments || 0);
    const count = files.length + (payload.urls || []).length;
    if (count < want) {
      missing.push(want === 1
        ? 'An attachment is required.'
        : `${want} attachments are required — ${count} attached.`);
    }
  }

  if (need.signature && !payload.signature) {
    missing.push('A signature is required.');
  }

  if (need.location && !(payload.location && payload.location.lat != null)) {
    missing.push('Your location is required.');
  }

  // Every custom field the task type marked required.
  for (const f of task.customFields || []) {
    if (!f.required) continue;
    const given = payload.fieldValues && payload.fieldValues[f.key];
    const onTask = f.value;
    if ((given == null || given === '') && (onTask == null || onTask === '')) {
      missing.push(`"${f.label || f.key}" is required.`);
    }
  }

  return missing;
}

/** The requirements a task has switched on, as labels — for the submission form. */
function requirementLabels(task) {
  const need = task.requirements || {};
  return Object.keys(REQUIREMENT_LABELS)
    .filter((k) => need[k])
    .map((k) => ({ key: k, label: REQUIREMENT_LABELS[k] }));
}

// ===== Dependencies (section 9) =====

/**
 * Which of this task's blockers are not satisfied yet.
 *
 * A dependent task must not become workable until what it waits on is done
 * (section 9), so this is checked when somebody tries to START — not when the
 * task is created, because the blocker may well be finished by then.
 *
 * @param {object} task
 * @returns {Promise<Array<{title:string, code:string, status:string}>>}
 */
async function unmetDependencies(task) {
  const blockers = (task.dependencies || []).filter((d) => d.kind === 'blockedBy');
  if (!blockers.length) return [];
  const ids = blockers.map((d) => d.task);
  const rows = await Task.find({ _id: { $in: ids } }).select('title code status').lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const unmet = [];
  for (const dep of blockers) {
    const other = byId.get(String(dep.task));
    if (!other) continue; // a blocker that no longer exists blocks nothing
    const want = normaliseStatus(dep.satisfiedBy) || 'COMPLETED';
    const have = normaliseStatus(other.status) || other.status;
    const satisfied = have === want || (want === 'COMPLETED' && have === 'COMPLETED');
    if (!satisfied) unmet.push({ title: other.title, code: other.code, status: have });
  }
  return unmet;
}

/**
 * Refuse to start a task whose blockers are still open, naming them.
 * @param {object} task
 * @returns {Promise<void>}
 * @throws {Error} 409
 */
async function assertDependenciesMet(task) {
  const unmet = await unmetDependencies(task);
  if (!unmet.length) return;
  const names = unmet.map((t) => `"${t.title}"`).join(', ');
  throw httpError(409, unmet.length === 1
    ? `This task is waiting on ${names}, which is not finished yet.`
    : `This task is waiting on ${unmet.length} others: ${names}.`);
}

// ===== Roll-ups =====

/**
 * Recompute the counters a task keeps about its children and its time, and save.
 *
 * Always recomputed from the rows, never incremented — the mistake that makes a
 * figure drift the first time something is corrected or deleted. Cheap: two
 * counts and a small aggregate, run when a child or an entry actually changes.
 *
 * @param {*} taskId
 * @returns {Promise<object|null>} the refreshed task
 */
async function recomputeRollups(taskId) {
  const task = await Task.findById(taskId);
  if (!task) return null;

  const TaskTimeEntry = require('../models/TaskTimeEntry');

  const [subtasks, minutesByUser] = await Promise.all([
    Task.find({ parentTask: task._id }).select('status').lean(),
    TaskTimeEntry.aggregate([
      { $match: { task: task._id, approvalStatus: { $ne: 'Rejected' } } },
      { $group: { _id: '$user', minutes: { $sum: '$activeMinutes' } } },
    ]),
  ]);

  task.subtaskCount = subtasks.length;
  task.subtaskDoneCount = subtasks.filter((s) => (normaliseStatus(s.status) || s.status) === 'COMPLETED').length;

  const byUser = new Map(minutesByUser.map((r) => [String(r._id), r.minutes]));
  for (const a of task.assignees || []) {
    a.minutesLogged = byUser.get(String(a.user)) || 0;
  }
  task.minutesLogged = minutesByUser.reduce((t, r) => t + (r.minutes || 0), 0);

  await task.save();
  return task;
}

/**
 * Bring the assignee rows into step with a task-level move.
 *
 * A single-assignee task is one thing wearing two hats — the task's status and
 * that person's status are the same fact — so moving one has to move the other
 * or the detail page contradicts its own header. On a multi-assignee task the
 * rows are genuinely independent and only the person who acted is touched.
 *
 * @param {object} task - a Task document (mutated, not saved)
 * @param {string} status
 * @param {*} [userId] - whose row to move; omitted, moves everyone's
 * @returns {object} the task
 */
function syncAssigneeStatus(task, status, userId) {
  const rows = task.assignees || [];
  const targets = userId
    ? rows.filter((a) => String(a.user?._id || a.user) === String(userId))
    : rows;
  const now = new Date();
  for (const a of targets) {
    a.status = status;
    if (status === 'ACCEPTED' && !a.acceptedAt) a.acceptedAt = now;
    if (status === 'IN_PROGRESS' && !a.startedAt) a.startedAt = now;
    if (status === 'SUBMITTED' && !a.submittedAt) a.submittedAt = now;
    if (status === 'COMPLETED') {
      a.completedAt = a.completedAt || now;
      a.progress = 100;
    }
  }
  return task;
}

/**
 * Has every person on the task reached this status?
 * The question the roll-up asks before moving the task itself: one assignee
 * submitting their part does not mean the task is submitted.
 * @param {object} task
 * @param {string[]} statuses - any of these counts
 * @returns {boolean}
 */
function allAssigneesAt(task, statuses) {
  const rows = (task.assignees || []).filter((a) => a.role !== 'Observer');
  if (!rows.length) return false;
  return rows.every((a) => statuses.includes(normaliseStatus(a.status) || a.status));
}

module.exports = {
  httpError,
  actorRoles,
  assertCanTransition,
  transition,
  logActivity,
  checkGeofence,
  missingRequirements,
  requirementLabels,
  unmetDependencies,
  assertDependenciesMet,
  recomputeRollups,
  syncAssigneeStatus,
  allAssigneesAt,
  fullName,
  legacyAliases,
};
