/**
 * Every notification this module sends, in one file (sections 35 and 50).
 *
 * The module notifies in every direction — the assignee when work arrives, the
 * assigner when it moves, the approver when something needs a decision, the
 * supervisor when a deadline passes and the manager when it keeps passing — and
 * spreading that across six controllers is how a module ends up with three
 * different wordings for the same event and one path that quietly tells nobody.
 *
 * IT DOES NOT SEND ANYTHING ITSELF. Everything goes through services/notify.js,
 * which writes the in-app row AND pushes to the phone together. What this adds
 * is the module's own vocabulary: who cares about which event, which portal the
 * alert belongs in, where tapping it should land, and how loud it is.
 *
 * THE PORTAL MATTERS. `audience` decides which portal a dual-role account reads
 * an alert in. A task you have to DO is employee-portal news even when you are
 * an HR Manager; a task you have to APPROVE or that you handed out is admin-
 * portal news. Getting this wrong is the difference between an alert somebody
 * finds and one they never see.
 *
 * SEVERITY (section 50) rides along in the push payload as `severity`, so the
 * app can decide how to present it without re-deriving the rule.
 */
const { notify, notifyMany } = require('./notify');
const { statusLabel } = require('../config/taskWorkflow');

// Where a tapped alert lands. The employee path is resolved straight through by
// the web portal and by the app's PATH_SCREENS table; the admin one needs the
// app's ADMIN_PATH_SCREENS rule, or a suffix match on '/tasks' opens the
// reader's OWN task list instead of the board the alert is about — the trap this
// module already hit once.
const EMPLOYEE_LINK = '/employee/tasks';
const ADMIN_LINK = '/admin/tasks';

/** A deep link to one task, for whichever portal the reader is in. */
const employeeTaskLink = (id) => `/employee/tasks/${id}`;
const adminTaskLink = (id) => `/admin/tasks/${id}`;

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  hour12: true, timeZone: 'Asia/Kolkata',
});

/**
 * The one-line tail that turns a bare title into something actionable —
 * "· Urgent · due 12 Mar 2026". Built from whatever the task actually has, so a
 * task with neither prints neither rather than an empty label.
 * @param {object} task
 * @returns {string}
 */
function taskMeta(task) {
  const bits = [];
  if (task.priority && task.priority !== 'Medium') bits.push(task.priority);
  if (task.dueDate) bits.push(`due ${fmtDate(task.dueDate)}`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/** "TSK-2026-00042 — Employee Onboarding", or just the title before codes existed. */
const taskName = (task) => (task.code ? `${task.code} — ${task.title}` : `"${task.title}"`);

const nameOf = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'Somebody';

/** Ids as strings, deduped, with the actor removed — nobody is told their own doing. */
function recipients(ids, actorId) {
  const skip = String(actorId || '');
  return [...new Set((ids || []).filter(Boolean).map((i) => String(i._id || i)))]
    .filter((id) => id && id !== skip);
}

/**
 * Send, without ever letting a notification break the thing that caused it.
 * Every function below funnels through here.
 * @returns {Promise<void>}
 */
async function send(ids, payload) {
  try {
    if (!ids.length) return;
    if (ids.length === 1) {
      await notify({ recipient: ids[0], ...payload });
    } else {
      await notifyMany(ids, payload);
    }
  } catch (err) {
    console.error('Task notification failed:', err.message);
  }
}

// ===== To the people doing the work =====

/**
 * A task is now yours.
 * @param {object} task
 * @param {Array} userIds - the new assignees
 * @param {object} actor - who assigned it
 * @param {string} [title]
 */
function assigned(task, userIds, actor, title = 'New task assigned') {
  const ids = recipients(userIds, actor && actor._id);
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title,
    body: `${taskName(task)}${taskMeta(task)}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: task.priority === 'Urgent' ? 'HIGH' : 'INFO' },
  });
}

/** Your task changed under you — and what changed. */
function edited(task, userIds, changed, actor) {
  const ids = recipients(userIds, actor && actor._id);
  if (!changed.length) return Promise.resolve();
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title: 'Task updated',
    body: `${taskName(task)} — ${changed.join(', ')} changed${taskMeta(task)}.`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

/** Your work was sent back, with the reason attached. */
function rejected(task, userIds, reviewer, note) {
  const ids = recipients(userIds, reviewer && reviewer._id);
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title: 'Task sent back',
    body: `${nameOf(reviewer)} sent ${taskName(task)} back${note ? `: ${String(note).slice(0, 200)}` : '.'}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'HIGH' },
  });
}

/** Your work was approved. */
function approved(task, userIds, reviewer, note) {
  const ids = recipients(userIds, reviewer && reviewer._id);
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title: 'Task approved',
    body: `${nameOf(reviewer)} approved ${taskName(task)}${note ? `: ${String(note).slice(0, 200)}` : '.'}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

/** The whole thing is finished. */
function completed(task, userIds) {
  const ids = recipients(userIds);
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title: 'Task completed',
    body: `${taskName(task)} is complete.`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

// ===== To the people watching =====

/**
 * The assignee moved their own task — told to whoever handed it over.
 *
 * The ASSIGNER is the one person who definitely wants to know, so `createdBy` is
 * the recipient wherever there is one. Two cases fall back to the supervisor and
 * then to the `tasks.manage` bench: a task created before the field existed, and
 * one whose assigner has since left. An orphaned task's progress should still
 * reach somebody rather than nobody — and the fallback is walled to the
 * assignee's own company, so another company's HR never hears about their people.
 */
function movedByAssignee(task, watcherIds, actor, from, to) {
  const ids = recipients(watcherIds, actor && actor._id);
  return send(ids, {
    type: 'task',
    audience: 'admin',
    title: to === 'COMPLETED' ? 'Task completed' : 'Task moved by assignee',
    body: `${nameOf(actor)} moved ${taskName(task)} from ${statusLabel(from)} to ${statusLabel(to)}.`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

/** Somebody refused a task they were given. */
function declined(task, watcherIds, actor, reason) {
  const ids = recipients(watcherIds, actor && actor._id);
  return send(ids, {
    type: 'task',
    audience: 'admin',
    title: 'Task declined',
    body: `${nameOf(actor)} declined ${taskName(task)}${reason ? `: ${String(reason).slice(0, 200)}` : '.'}`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'HIGH' },
  });
}

/** Work has been handed back and needs a decision. */
function submitted(task, approverIds, actor) {
  const ids = recipients(approverIds, actor && actor._id);
  return send(ids, {
    type: 'task',
    audience: 'admin',
    title: 'Task submitted for review',
    body: `${nameOf(actor)} submitted ${taskName(task)}.`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'WARNING' },
  });
}

/** A workflow step has opened and is waiting on these people. */
function approvalNeeded(task, approverIds, step) {
  const ids = recipients(approverIds);
  return send(ids, {
    type: 'task',
    audience: 'admin',
    title: 'Approval required',
    body: `${taskName(task)} is waiting on you${step && step.name ? ` at "${step.name}"` : ''}.`
      + (step && step.dueAt ? ` Due ${fmtDateTime(step.dueAt)}.` : ''),
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), stepKey: step && step.key, severity: 'WARNING' },
  });
}

// ===== Deadlines (sections 19–20) =====

/**
 * A due date is approaching. `hours` is how far ahead, so the sentence can say
 * "in 1 hour" rather than repeating the date.
 */
function dueSoon(task, userIds, hours) {
  const ids = recipients(userIds);
  const when = hours >= 24
    ? `${Math.round(hours / 24)} day${hours >= 48 ? 's' : ''}`
    : hours >= 1
      ? `${Math.round(hours)} hour${hours >= 2 ? 's' : ''}`
      : `${Math.round(hours * 60)} minutes`;
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title: `Task due in ${when}`,
    body: `${taskName(task)} is due ${fmtDateTime(task.dueDate)}.`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: hours <= 1 ? 'WARNING' : 'INFO' },
  });
}

/**
 * A deadline has passed. Who hears about it depends on how long ago, which is
 * what makes this an escalation rather than a repeated nudge — see
 * services/taskReminderWorker.js for the ladder.
 */
function overdue(task, userIds, { hoursLate, to = 'assignee', severity = 'HIGH' }) {
  const ids = recipients(userIds);
  const late = hoursLate >= 24
    ? `${Math.round(hoursLate / 24)} day${hoursLate >= 48 ? 's' : ''}`
    : `${Math.round(hoursLate)} hour${hoursLate >= 2 ? 's' : ''}`;
  const mine = to === 'assignee';
  return send(ids, {
    type: 'task',
    audience: mine ? 'employee' : 'admin',
    title: mine ? 'Task overdue' : 'Overdue task on your team',
    body: mine
      ? `${taskName(task)} was due ${fmtDateTime(task.dueDate)} — ${late} ago.`
      : `${taskName(task)} is ${late} overdue.`,
    link: mine ? employeeTaskLink(task._id) : adminTaskLink(task._id),
    data: { taskId: String(task._id), severity },
  });
}

/** A task nobody has accepted yet (section 10). */
function notAccepted(task, userIds, { to = 'assignee', hours }) {
  const ids = recipients(userIds);
  const mine = to === 'assignee';
  return send(ids, {
    type: 'task',
    audience: mine ? 'employee' : 'admin',
    title: mine ? 'Please accept your task' : 'Task not accepted',
    body: mine
      ? `${taskName(task)} has been waiting ${Math.round(hours)} hours for you to accept it.`
      : `${taskName(task)} has not been accepted after ${Math.round(hours)} hours.`,
    link: mine ? employeeTaskLink(task._id) : adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: mine ? 'WARNING' : 'HIGH' },
  });
}

/** The escalation ladder reached somebody new. */
function escalated(task, userIds, level, reason) {
  const ids = recipients(userIds);
  return send(ids, {
    type: 'task',
    audience: 'admin',
    title: 'Task escalated',
    body: `${taskName(task)} has been escalated to you${reason ? `: ${reason}` : '.'}`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: level >= 3 ? 'CRITICAL' : 'HIGH' },
  });
}

// ===== Extensions, handover, comments =====

function extensionRequested(task, approverIds, actor, requestedDue) {
  const ids = recipients(approverIds, actor && actor._id);
  return send(ids, {
    type: 'task',
    audience: 'admin',
    title: 'Deadline extension requested',
    body: `${nameOf(actor)} asked to move ${taskName(task)} to ${fmtDate(requestedDue)}.`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'WARNING' },
  });
}

function extensionDecided(task, userIds, approved2, newDue, decider, note) {
  const ids = recipients(userIds, decider && decider._id);
  return send(ids, {
    type: 'task',
    audience: 'employee',
    title: approved2 ? 'Extension approved' : 'Extension rejected',
    body: approved2
      ? `${taskName(task)} is now due ${fmtDate(newDue)}.`
      : `${nameOf(decider)} did not extend ${taskName(task)}${note ? `: ${String(note).slice(0, 200)}` : '.'}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: approved2 ? 'INFO' : 'WARNING' },
  });
}

function handedOver(task, toUserId, fromUser, actor, note) {
  return send(recipients([toUserId], actor && actor._id), {
    type: 'task',
    audience: 'employee',
    title: 'Task handed over to you',
    body: `${taskName(task)} was ${fromUser ? `${nameOf(fromUser)}'s and is ` : ''}now yours`
      + `${note ? `: ${String(note).slice(0, 200)}` : `${taskMeta(task)}.`}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'HIGH' },
  });
}

/**
 * A new comment. Goes to everybody involved except the author — and to the
 * EMPLOYEE portal for assignees, the ADMIN portal for reviewers, which is why
 * this one sends two messages rather than one to a merged list.
 */
async function commented(task, { assigneeIds, reviewerIds }, author, body, internal) {
  const excerpt = String(body || '').replace(/\s+/g, ' ').slice(0, 160);
  // An internal note is between reviewers; the assignee is deliberately not told.
  if (!internal) {
    await send(recipients(assigneeIds, author && author._id), {
      type: 'task',
      audience: 'employee',
      title: `${nameOf(author)} commented`,
      body: `${taskName(task)}: ${excerpt}`,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), severity: 'INFO' },
    });
  }
  await send(recipients(reviewerIds, author && author._id), {
    type: 'task',
    audience: 'admin',
    title: `${nameOf(author)} commented`,
    body: `${taskName(task)}: ${excerpt}`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

/** Somebody was named in a comment. */
function mentioned(task, userIds, author, body) {
  return send(recipients(userIds, author && author._id), {
    type: 'task',
    audience: 'all',
    title: `${nameOf(author)} mentioned you`,
    body: `${taskName(task)}: ${String(body || '').replace(/\s+/g, ' ').slice(0, 160)}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), severity: 'WARNING' },
  });
}

// ===== Incentive (section 25) =====

/** Points are waiting to be sanctioned. */
function incentivePending(task, approverIds, points, earnerName) {
  return send(recipients(approverIds), {
    type: 'task',
    audience: 'admin',
    title: 'Task incentive to approve',
    body: `${points} point${points === 1 ? '' : 's'} for ${earnerName} on ${taskName(task)}.`,
    link: '/admin/tasks?tab=incentives',
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

/** Points have joined the pool. */
function incentiveCredited(task, userId, points) {
  return send(recipients([userId]), {
    type: 'task',
    audience: 'employee',
    title: 'Incentive points earned',
    body: `${points} point${points === 1 ? '' : 's'} credited for ${taskName(task)}.`,
    link: '/employee/my-incentive',
    data: { taskId: String(task._id), severity: 'INFO' },
  });
}

module.exports = {
  EMPLOYEE_LINK,
  ADMIN_LINK,
  employeeTaskLink,
  adminTaskLink,
  taskMeta,
  taskName,
  assigned,
  edited,
  rejected,
  approved,
  completed,
  movedByAssignee,
  declined,
  submitted,
  approvalNeeded,
  dueSoon,
  overdue,
  notAccepted,
  escalated,
  extensionRequested,
  extensionDecided,
  handedOver,
  commented,
  mentioned,
  incentivePending,
  incentiveCredited,
};
