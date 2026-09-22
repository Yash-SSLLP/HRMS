/**
 * THE ONLY WAY A TASK'S STATUS MOVES.
 *
 * REWRITTEN 2026-09-21 — 730 lines down to this. The engine it replaces drove a
 * twelve-state machine through a workflow runtime with parallel and conditional
 * steps, an approval ladder and a dependency graph. There are now three states
 * and one rule, so what is left is the part that was always load-bearing:
 *
 *   1. the move is LEGAL           (config/tasks.TRANSITIONS)
 *   2. the mover is ENTITLED       (services/taskAccess.actorRoleOn)
 *   3. the move is SAID OUT LOUD   (a note, a voice note, or both)
 *   4. it happens ONCE            (a conditional update, not a re-read)
 *   5. everyone who cares HEARS    (services/taskNotify)
 *   6. the feed RECORDS it         (models/TaskUpdate — append only)
 *
 * WHY A SINGLE CHOKEPOINT SURVIVED THE SIMPLIFICATION. A task is moved from the
 * web portal, the Android app, the recurrence worker and the reminder worker,
 * and two of them can move the same task in the same second. With one function
 * owning it, "did this really happen?" is one conditional update; with the
 * logic spread across handlers it is a race that shows up as a task completed
 * twice and paid twice.
 *
 * PER-PERSON, THEN ROLLED UP. A task on three people is three jobs. A move
 * lands on the MOVER'S OWN assignee row; the task's headline status is derived
 * from all of them by the model (models/Task's rollUpStatus hook). An assigner
 * acting on a task that is not theirs to do — cancelling it, reopening it —
 * moves every row at once, because that is what those two moves mean.
 */
const mongoose = require('mongoose');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const {
  STATUS, ACCEPTANCE, transitionFor, effectiveTarget, isTerminal, statusLabel, KIND_TASK,
  MAX_SUBTASKS, MAX_SPLIT_DEPTH, clampProgress, normalisePriority,
  EXTENSION_STATUS, DEFAULT_PRIORITY,
} = require('../config/tasks');
const access = require('./taskAccess');
const points = require('./taskPoints');
const notify = require('./taskNotify');

/** Moves an assigner makes ON BEHALF of everybody rather than for themselves. */
const WHOLE_TASK_MOVES = new Set([STATUS.CANCELLED]);

/**
 * The moves the feed words for itself.
 *
 * A submission, an approval and a rejection are three different events and the
 * people reading a task's history argue about which one happened. Recording all
 * three as a generic `STATUS` row and leaving the client to work it out from
 * `from`/`to` is how two clients end up wording the same event differently.
 * Anything not named here stays `STATUS`.
 */
const FEED_KIND = {
  [`${STATUS.PENDING}>${STATUS.SUBMITTED}`]: 'SUBMITTED',
  [`${STATUS.IN_PROGRESS}>${STATUS.SUBMITTED}`]: 'SUBMITTED',
  [`${STATUS.SUBMITTED}>${STATUS.COMPLETED}`]: 'APPROVED',
  [`${STATUS.SUBMITTED}>${STATUS.IN_PROGRESS}`]: 'SENT_BACK',
};

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function personName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'Somebody';
}

/**
 * Move a task (or one person's part of it).
 *
 * @param {Object} opts
 * @param {string} opts.taskId
 * @param {Object} opts.user        the mover
 * @param {string} opts.to          the target status
 * @param {string} [opts.note]      their remark — required on most moves
 * @param {Object} [opts.voiceNote] {storagePath, mimeType, sizeBytes, durationMs}
 * @param {Array}  [opts.files]     attachment metadata to hang on the update
 * @param {string[]} [opts.mentions] user ids named in the note
 * @returns {Promise<{task: Object, update: Object}>}
 */
async function move({ taskId, user, to, note = '', voiceNote = null, files = [], mentions = [] }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);

  access.assertCanSee(user, task);

  const role = access.actorRoleOn(user, task);
  if (!role) throw fail('That task is not yours to act on.', 403);

  const from = task.status;

  /**
   * WHERE THIS ACTUALLY LANDS.
   *
   * A doer pressing Complete on a task that has to be reviewed is handing it
   * in, not finishing it — see config/tasks.effectiveTarget. Applied here,
   * ONCE, before anything else looks at the target, so every route into the
   * engine gets the same answer: the web's Submit button, the phone's Complete
   * button, an Android build from before this existed, and a template.
   */
  const wanted = to;
  to = effectiveTarget(task, role, to, user._id);

  if (from === to) {
    // Not an error: two taps on Complete, or the phone retrying a request it
    // never saw the answer to. Say nothing happened and return what is there.
    return { task, update: null, unchanged: true };
  }

  const rule = transitionFor(from, to);
  if (!rule) {
    throw fail(
      `A ${statusLabel(from, task.kind).toLowerCase()} ${task.kind === KIND_TASK ? 'task' : 'request'} `
      + `cannot be marked ${statusLabel(to, task.kind).toLowerCase()}.`
    );
  }
  if (!rule.by.includes(role)) {
    throw fail(
      role === 'doer'
        ? 'Only the person who set this can make that change.'
        : 'Only the person doing this can make that change.',
      403
    );
  }

  const said = String(note || '').trim();
  if (rule.note && !said && !voiceNote) {
    const why = {
      [STATUS.COMPLETED]: from === STATUS.SUBMITTED
        ? 'Say a word about what you are approving.'
        : 'Add a note (or a voice note) saying what was done before marking this complete.',
      [STATUS.SUBMITTED]: 'Say what you did before handing this in — a voice note counts.',
      [STATUS.IN_PROGRESS]: from === STATUS.SUBMITTED
        ? 'Say what needs doing before sending this back.'
        : 'Add a note (or a voice note) explaining this change.',
    }[to];
    throw fail(why || 'Add a note (or a voice note) explaining this change.');
  }

  const now = new Date();
  const mine = task.assigneeFor(user._id);
  /**
   * Whose rows this move touches.
   *
   * Normally just the mover's own. But an ASSIGNER'S VERDICT on a submission is
   * a verdict on the whole task, not on one row: approving lands on everybody
   * who handed in, and sending it back reopens for everybody who did. A
   * per-row approve would leave a five-person task half in review for ever,
   * with the manager having to press Approve five times to say one thing.
   */
  const verdict = from === STATUS.SUBMITTED && role === 'assigner'
    && (to === STATUS.COMPLETED || to === STATUS.IN_PROGRESS || to === STATUS.PENDING);
  const wholeTask = WHOLE_TASK_MOVES.has(to) || verdict || !mine;

  // ===== 4. It happens once =====
  //
  // A conditional update on the CURRENT status: if another request has already
  // moved this task, the update matches nothing and we stop. Cheaper and more
  // honest than re-reading and comparing, which still leaves a window.
  const claimed = await Task.updateOne(
    { _id: task._id, status: from },
    { $set: { stateNote: said.slice(0, 1000) || task.stateNote } }
  );
  if (claimed.matchedCount === 0) {
    throw fail('Somebody else moved this task a moment ago. Open it again to see where it is.', 409);
  }

  // ===== Apply =====
  const rows = wholeTask ? (task.assignees || []) : [mine];
  const awarded = [];

  for (const row of rows) {
    // STARTING WORK IMPLIES ACCEPTANCE. Chasing somebody for an acknowledgement
    // of a job they have visibly begun is exactly the ceremony this module
    // exists to remove — see config/tasks.ACCEPTANCE.
    if ((to === STATUS.IN_PROGRESS || to === STATUS.COMPLETED)
      && row.acceptance === ACCEPTANCE.AWAITING) {
      row.acceptance = ACCEPTANCE.ACCEPTED;
      row.acceptedAt = now;
    }

    if (to === STATUS.IN_PROGRESS) {
      // Reopening a completed row takes its points back before it moves.
      if (row.status === STATUS.COMPLETED) {
        const rev = await points.reverse(task, row);
        if (rev?.keptCredit) awarded.push({ row, keptCredit: true });
        row.completedAt = undefined;
        row.completedLate = false;
      }
      // SENT BACK. The submission is withdrawn from the tray, but the date it
      // was handed in is NOT forgotten: if the second attempt is approved, the
      // person still delivered late (or on time) the first time, and
      // `completedLate` below reads that stamp. Clearing it here would let a
      // rejected-then-fixed task come out punctual, which is the one thing the
      // In Time / Delayed split must never do.
      if (row.status === STATUS.SUBMITTED && role === 'assigner') {
        task.rejectionCount = (task.rejectionCount || 0) + 1;
      }
      row.status = STATUS.IN_PROGRESS;
      if (!row.startedAt) row.startedAt = now;
    } else if (to === STATUS.SUBMITTED) {
      // HANDED IN. This is the moment punctuality is decided — not the moment
      // somebody gets round to approving it. See the field's note on the model.
      row.status = STATUS.SUBMITTED;
      if (!row.startedAt) row.startedAt = now;
      if (!row.submittedAt) row.submittedAt = now;
      if (!row.progress) row.progress = 100;
      row.completedLate = Boolean(task.dueDate && row.submittedAt > new Date(task.dueDate));
    } else if (to === STATUS.COMPLETED) {
      row.status = STATUS.COMPLETED;
      if (!row.startedAt) row.startedAt = now;
      row.completedAt = now;
      row.progress = 100;
      // Frozen here, never re-derived: moving the deadline afterwards must not
      // turn a late delivery into a punctual one. When the row passed through
      // review, the stamp that counts is the SUBMISSION — the doer is answerable
      // for when they handed it in, not for how long the tray took.
      row.completedLate = row.submittedAt
        ? Boolean(task.dueDate && new Date(row.submittedAt) > new Date(task.dueDate))
        : Boolean(task.dueDate && now > new Date(task.dueDate));
      const paid = await points.award(task, row, user);
      if (paid) awarded.push({ row, ...paid });
    } else if (to === STATUS.PENDING) {
      if (row.status === STATUS.COMPLETED) await points.reverse(task, row);
      row.status = STATUS.PENDING;
      row.startedAt = undefined;
      row.completedAt = undefined;
      row.submittedAt = undefined;
      row.completedLate = false;
    } else if (to === STATUS.CANCELLED) {
      if (row.status === STATUS.COMPLETED) await points.reverse(task, row);
      row.status = STATUS.CANCELLED;
    }
  }

  // CANCELLED is the one status set directly rather than rolled up — it is the
  // assigner overruling everybody at once (see the model's rollUpStatus hook).
  if (to === STATUS.CANCELLED) task.status = STATUS.CANCELLED;
  if (said) task.stateNote = said.slice(0, 1000);

  // A move clears the chasing schedule's memory when the deadline is back in
  // play, so reopening a task does not leave it permanently un-remindable.
  if (to === STATUS.PENDING || to === STATUS.IN_PROGRESS) task.firedReminders = [];
  if (to === STATUS.IN_PROGRESS || to === STATUS.PENDING) task.submittedAt = undefined;

  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  // A piece moving changes its parent's "3 of 5 done" line and its progress
  // bar. Done after the save, so the parent reads the row that actually landed.
  if (task.parentTask) {
    await recomputeParent(task.parentTask).catch(
      (e) => console.error('parent recompute failed:', e.message)
    );
  }

  // ===== 6. The feed =====
  const update = await TaskUpdate.create({
    task: task._id,
    kind: FEED_KIND[`${from}>${task.status}`] || 'STATUS',
    by: user._id,
    byName: personName(user),
    from,
    to: task.status,
    note: said,
    voiceNote: voiceNote || undefined,
    files: files || [],
    mentions: mentions || [],
  });

  // Hang any files on the task itself too, so the detail page's file list is
  // one array rather than a merge of the task's and every update's.
  if (files?.length) {
    task.attachments.push(
      ...files.map((f) => ({
        ...f,
        uploadedBy: user._id,
        uploadedByName: personName(user),
        update: update._id,
      }))
    );
    await task.save();
  }

  // ===== 5. Everyone who cares =====
  notify.statusMoved(task, update, user).catch((e) => console.error('task notify failed:', e.message));

  // `coerced` is how the client knows to say "sent for review" rather than
  // "completed" after somebody pressed Complete — see effectiveTarget.
  return { task, update, awarded, coerced: wanted !== to, requested: wanted };
}

/**
 * Take the job on.
 *
 * Acknowledgement, not a status move — the task stays PENDING until somebody
 * actually starts. See config/tasks.ACCEPTANCE for why these are two axes.
 */
async function accept({ taskId, user, note = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const mine = task.assigneeFor(user._id);
  if (!mine) throw fail('That task is not yours to accept.', 403);
  if (mine.acceptance === ACCEPTANCE.ACCEPTED) {
    return { task, update: null, unchanged: true };
  }

  const now = new Date();
  mine.acceptance = ACCEPTANCE.ACCEPTED;
  mine.acceptedAt = now;
  // Accepting after declining is allowed and is the point: a refusal that can
  // be talked round should not need the assigner to reassign the whole task.
  mine.declinedAt = undefined;
  mine.declineReason = undefined;

  /**
   * ACCEPTING STARTS THE WORK (2026-09-22, fourth pass).
   *
   * The brief describes the board in one sentence: *"in todo all the assigned
   * task will come, after accepting that it will come to in progress"*. So
   * taking a job on moves it out of To Do.
   *
   * The two axes still exist and still answer different questions — a refusal
   * has nowhere else to live, and "started without ever pressing Accept" is
   * still legal and still the common case. What changed is only that the
   * cheaper of the two buttons now does both, because "Accepted, and also press
   * Start" is a distinction the person pressing it does not have and should not
   * be taught.
   */
  if (mine.status === STATUS.PENDING) {
    mine.status = STATUS.IN_PROGRESS;
    if (!mine.startedAt) mine.startedAt = now;
  }
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  if (task.parentTask) {
    await recomputeParent(task.parentTask).catch(
      (e) => console.error('parent recompute failed:', e.message)
    );
  }

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'ACCEPTED',
    by: user._id,
    byName: personName(user),
    note: String(note || '').trim() || 'Accepted this, and started on it.',
  });

  notify.accepted(task, update, user).catch((e) => console.error('task notify failed:', e.message));
  return { task, update };
}

/**
 * Refuse it, with a reason.
 *
 * THE REASON IS REQUIRED. A refusal with no reason cannot be acted on by the
 * person who now has to reassign the work, and "declined" on its own reads as
 * insubordination when it is usually "I am on leave from Thursday".
 *
 * Declining does NOT cancel the task. It takes this person off the hook and
 * hands the problem back to whoever set it, who reassigns, delegates or calls
 * it off. A task everybody has declined shows as Declined
 * (config/tasks.isDeclined) and stays on the assigner's list until they act.
 */
async function decline({ taskId, user, reason = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const mine = task.assigneeFor(user._id);
  if (!mine) throw fail('That task is not yours to decline.', 403);
  if (mine.status === STATUS.COMPLETED) {
    throw fail('You have already finished this one — it cannot be declined now.');
  }

  const why = String(reason || '').trim();
  if (!why) throw fail('Say why you cannot take this on, so it can be given to somebody else.');

  mine.acceptance = ACCEPTANCE.REJECTED;
  mine.declinedAt = new Date();
  mine.declineReason = why.slice(0, 500);
  // Their own progress is wound back: they are not doing it.
  mine.status = STATUS.PENDING;
  mine.startedAt = undefined;
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'REJECTED',
    by: user._id,
    byName: personName(user),
    note: why,
  });

  notify.declined(task, update, user).catch((e) => console.error('task notify failed:', e.message));
  return { task, update };
}

/**
 * Hand your own piece of it to somebody else.
 *
 * NOT the same as reassigning (PATCH /:id, the assigner's). This is the DOER
 * passing their own job on, and it carries three rules:
 *
 *  1. THE DIRECTION RULE APPLIES. You may delegate down or across, never up —
 *     otherwise delegation would be the hole in the wall that the whole
 *     task/request split exists to close.
 *  2. THE DELEGATOR KEEPS HEARING ABOUT IT. They drop out of `assignees` but
 *     stay in the task's audience for good, because they are still the person
 *     who was asked (models/Task.originalAssignees, and the trail here).
 *  3. THE NEW PERSON STARTS FRESH — AWAITING acceptance, PENDING, no inherited
 *     progress. They can accept or decline it exactly as if it had been set on
 *     them, which is the point of delegating rather than quietly swapping a name.
 */
async function delegate({ taskId, user, to, note = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const mine = task.assigneeFor(user._id);
  if (!mine) throw fail('That task is not yours to pass on.', 403);
  if (mine.status === STATUS.COMPLETED) throw fail('You have already finished this one.');

  const targetId = String(to || '');
  if (!mongoose.Types.ObjectId.isValid(targetId)) throw fail('Choose who to pass it to.');
  if (targetId === String(user._id)) throw fail('That is already you.');
  if (task.isDoer(targetId)) throw fail('They are already on this task.');

  // Rule 1 — the same check the assign form makes.
  await access.resolveAssignmentKind(user, [targetId], task.kind);

  const User = require('../models/User');
  const EmployeeProfile = require('../models/EmployeeProfile');
  const target = await User.findById(targetId).select('firstName lastName').lean();
  if (!target) throw fail('That person is no longer here.');
  const profile = await EmployeeProfile.findOne({ user: targetId }).select('employeeCode').lean();

  const said = String(note || '').trim();
  const now = new Date();

  // Rule 3 — a fresh row, not a rename of the old one.
  const fresh = {
    user: targetId,
    name: [target.firstName, target.lastName].filter(Boolean).join(' ').trim(),
    employeeCode: profile?.employeeCode || '',
    status: STATUS.PENDING,
    acceptance: ACCEPTANCE.AWAITING,
    delegatedFrom: user._id,
    delegatedFromName: personName(user),
  };
  task.assignees = (task.assignees || [])
    .filter((a) => String(a.user?._id || a.user) !== String(user._id))
    .concat([fresh]);

  task.delegations.push({
    from: user._id,
    fromName: personName(user),
    to: targetId,
    toName: fresh.name,
    note: said.slice(0, 1000),
    at: now,
  });

  // Rule 2 — the delegator keeps hearing about it. `originalAssignees` already
  // holds whoever had it FIRST; this adds anybody who has held it since, so a
  // three-hop chain keeps everyone in it informed.
  const following = new Set((task.originalAssignees || []).map(String));
  following.add(String(user._id));
  task.originalAssignees = [...following];

  /**
   * Rule 4 — THE DELEGATOR NOW SIGNS IT OFF (2026-09-22).
   *
   * The brief: *"for delegate who is doing delegate he should be the approvar
   * for that chain"*. A CEO who hands a manager a report did not ask to read
   * the junior's draft; they asked the manager for a report. So each hop moves
   * the approval with the work: whoever handed it to you is who you answer to.
   *
   * `createdBy` is deliberately untouched — the CEO still SET this task, and
   * the feed, the Delegated tab and the audit trail all still need that to be
   * true. See models/Task.approver.
   */
  task.approver = user._id;
  task.approverName = personName(user);

  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'DELEGATED',
    by: user._id,
    byName: personName(user),
    note: said ? `Passed to ${fresh.name} — ${said}` : `Passed to ${fresh.name}.`,
  });

  notify.delegated(task, update, user, fresh)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, delegatedTo: fresh };
}

/**
 * Hand the task to the person it should have gone to in the first place.
 *
 * Added 2026-09-22 at the user's request: *"if the task is assigned to wrong
 * user then they can transfer to anyone and it will be fully transferred to the
 * new user"*.
 *
 * TRANSFER IS NOT DELEGATE, and the difference is the entire reason both exist:
 *
 *   delegate   I still own the outcome. I stay in `originalAssignees`, I
 *              become the approver, I keep hearing about every update, and the
 *              trail says the work passed through me.
 *   transfer   it was never mine. I come OFF the task completely and the new
 *              person holds it as if it had been theirs from the start.
 *
 * Three consequences of "fully transferred", each deliberate:
 *
 * 1. **The direction rule does not apply.** It is the one operation here that
 *    is allowed to go anywhere, because a mis-assignment can point in any
 *    direction and refusing to correct one upward would leave the wrong person
 *    holding it for ever. The company wall still applies — `canSee` and the
 *    picker both narrow to people this caller may act on at all.
 * 2. **`originalAssignees` IS rewritten.** It is the only place in the module
 *    that rewrites it, and the reason is that it drives notifications: leaving
 *    a mis-assigned person on every future update of a task that was never
 *    theirs is how people learn to ignore the bell. The history is not lost —
 *    it moves to `transfers`, which is append-only.
 * 3. **The work starts again from the top.** The new person gets PENDING and
 *    AWAITING, and any progress, submission or start time on the old row goes
 *    with the old row. They did not do that work and must not inherit it.
 *
 * Points already CREDITED are never touched: somebody was paid for what they
 * did before the mistake was noticed, and clawing that back silently is how a
 * payslip stops reconciling (see services/taskPoints).
 */
async function transferTask({ taskId, user, to, reason = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);
  if (!access.canTransfer(user, task)) {
    throw fail('Only the person who set this, or the person it is on, can transfer it.', 403);
  }
  if (isTerminal(task.status)) {
    throw fail(`This task is ${statusLabel(task.status, task.kind).toLowerCase()} — reopen it first.`);
  }

  const targetId = String(to || '');
  if (!mongoose.Types.ObjectId.isValid(targetId)) throw fail('Choose who to transfer it to.');
  if (task.isDoer(targetId) && (task.assignees || []).length === 1) {
    throw fail('It is already theirs.');
  }

  const User = require('../models/User');
  const target = await User.findById(targetId).select('firstName lastName isActive').lean();
  if (!target || target.isActive === false) throw fail('That person is no longer here.');

  const said = String(reason || '').trim();
  if (!said) {
    throw fail('Say why it is moving — the person picking it up has nothing else to go on.');
  }

  const codes = await employeeCodes([targetId]);
  const now = new Date();
  const leaving = (task.assignees || []).map((a) => ({
    id: String(a.user?._id || a.user),
    name: a.name || '',
  }));

  task.transfers.push({
    from: leaving[0]?.id || undefined,
    fromName: leaving[0]?.name || '',
    to: targetId,
    toName: [target.firstName, target.lastName].filter(Boolean).join(' ').trim(),
    by: user._id,
    byName: personName(user),
    reason: said.slice(0, 1000),
    at: now,
  });

  task.assignees = [{
    user: targetId,
    name: [target.firstName, target.lastName].filter(Boolean).join(' ').trim(),
    employeeCode: codes.get(targetId) || '',
    status: STATUS.PENDING,
    acceptance: ACCEPTANCE.AWAITING,
  }];
  task.assignedTo = targetId;
  task.assignedAt = now;
  // See consequence 2 in the docblock. The people who were on it stop being
  // notified; `transfers` keeps the record that they ever were.
  task.originalAssignees = [targetId];
  const gone = new Set(leaving.map((l) => l.id));
  task.loopUsers = (task.loopUsers || []).filter((u) => !gone.has(String(u._id || u)));
  // …and the task is nobody's work in progress any more.
  task.startedAt = undefined;
  task.submittedAt = undefined;
  task.completedAt = undefined;
  task.completedLate = false;
  task.progress = 0;
  task.firedReminders = [];
  task.stateNote = said.slice(0, 1000);
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  if (task.parentTask) {
    await recomputeParent(task.parentTask).catch(
      (e) => console.error('parent recompute failed:', e.message)
    );
  }

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'TRANSFERRED',
    by: user._id,
    byName: personName(user),
    note: leaving.length
      ? `Transferred from ${leaving.map((l) => l.name).filter(Boolean).join(', ') || 'nobody'} `
        + `to ${task.assignees[0].name} — ${said}`
      : `Transferred to ${task.assignees[0].name} — ${said}`,
  });

  notify.transferred(task, update, user, leaving)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, transferredTo: task.assignees[0] };
}

// ===== Pieces — splitting a task into child tasks =====
//
// REWORKED 2026-09-22. A piece used to be an embedded row on the parent with a
// title, an optional owner and a tick. It is now a TASK OF ITS OWN, because the
// brief asks it to do everything a task does — carry its own share of the
// points, its own deadline, its own progress, its own accept/decline, its own
// submission, and show up in its owner's list. See models/Task.parentTask.
//
// Three rules hold the whole thing together:
//
//   1. THE POINTS ARE A POOL, NOT A MINT. A piece draws from what the parent
//      already carries. The split cannot exceed it, ever, on any code path —
//      points settle in rupees (services/taskPoints) and a subtask that created
//      points from nothing would be a money printer with a + button.
//   2. THE DIRECTION RULE STILL APPLIES, per piece. A manager handing the CEO's
//      task down to their team is what this is for; handing a piece of it back
//      UP is the hole in the wall the task/request split exists to close.
//   3. THE PARENT'S COUNTERS ARE DERIVED, never typed. `recomputeParent` is the
//      only thing that writes them, and every path that touches a child calls
//      it — because a "3 of 5" that disagrees with the pieces underneath it is
//      worse than no figure at all.

/**
 * Re-derive a parent's counters and progress bar from its pieces.
 *
 * ONE query over the children, then a save. Called after every create, move,
 * edit, claim, archive and points change on a child — cheaper than a `$lookup`
 * on every list row, which at fifty rows a page is fifty joins to draw one line
 * of text.
 *
 * THE PROGRESS BAR IS POINTS-WEIGHTED, and it includes the parent's own share.
 * A manager who split 100 points as 60-to-the-team / 40-kept is 40% of the job
 * themselves, so a parent that shows 100% while its owner has not started is a
 * bar that lies. When nothing carries points at all, every part weighs the
 * same, which is the only sensible reading of an unweighted split.
 *
 * Recurses one hop UP (a piece of a piece), bounded by MAX_SPLIT_DEPTH.
 */
async function recomputeParent(parentId, hops = 0) {
  if (!parentId || hops >= MAX_SPLIT_DEPTH) return null;
  const parent = await Task.findById(parentId);
  if (!parent) return null;

  const children = await Task.find({ parentTask: parent._id, archived: { $ne: true } })
    .select('status points progress')
    .lean();

  const live = children.filter((c) => c.status !== STATUS.CANCELLED);
  parent.childCount = children.length;
  parent.childDoneCount = children.filter((c) => c.status === STATUS.COMPLETED).length;
  parent.distributedPoints = live.reduce((s, c) => s + (Number(c.points) || 0), 0);

  if (live.length) {
    const own = Math.max(0, (Number(parent.points) || 0) - parent.distributedPoints);
    const weighted = parent.distributedPoints > 0 || own > 0;

    const pctOf = (c) => (c.status === STATUS.COMPLETED || c.status === STATUS.SUBMITTED
      ? 100 : Math.min(100, Math.max(0, Number(c.progress) || 0)));

    // The parent's own share — the mean of its assignee rows, or 0 when nobody
    // is on it (a fully delegated task, where the remainder is nobody's).
    const rows = (parent.assignees || []).filter((a) => a.status !== STATUS.CANCELLED);
    const ownPct = rows.length
      ? rows.reduce((s, a) => s + (a.status === STATUS.COMPLETED || a.status === STATUS.SUBMITTED
        ? 100 : Math.min(100, Math.max(0, Number(a.progress) || 0))), 0) / rows.length
      : 0;

    let num = 0;
    let den = 0;
    for (const c of live) {
      const w = weighted ? (Number(c.points) || 0) : 1;
      num += pctOf(c) * w;
      den += w;
    }
    if (rows.length) {
      const w = weighted ? own : 1;
      num += ownPct * w;
      den += w;
    }
    parent.progress = den > 0 ? Math.round(num / den) : 0;
  }

  await parent.save();
  if (parent.parentTask) await recomputeParent(parent.parentTask, hops + 1);
  return parent;
}

/**
 * How the points are shared out when the splitter has not said.
 *
 * The brief: *"by default it will be divided equally"*. 100 over three is
 * 34/33/33, not 33/33/33 with a point quietly evaporating — the pool has to
 * come out whole or the arithmetic on screen stops adding up.
 *
 * Anything the splitter typed is honoured exactly; only the rest is shared, and
 * only out of what is left after the explicit figures are taken off.
 *
 * @returns {number[]} one figure per item, in the same order
 */
function shareOut(items, budget) {
  const explicit = items.map((it) => (
    it.points === undefined || it.points === null || it.points === ''
      ? null
      : Math.max(0, Math.round(Number(it.points) || 0))
  ));
  const named = explicit.reduce((s, p) => s + (p ?? 0), 0);
  if (named > budget) {
    throw fail(
      `That hands out ${named} points, and only ${budget} are left on this task. `
      + 'Lower the figures, or raise the task\'s own points first.'
    );
  }

  const autoIdx = explicit.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);
  if (!autoIdx.length) return explicit.map((p) => p ?? 0);

  const rest = budget - named;
  const base = Math.floor(rest / autoIdx.length);
  let spare = rest - base * autoIdx.length;

  const out = [...explicit];
  for (const i of autoIdx) {
    out[i] = base + (spare > 0 ? 1 : 0);
    if (spare > 0) spare -= 1;
  }
  return out.map((p) => p ?? 0);
}

/**
 * Split a task into pieces, each of them a task in its own right.
 *
 * Anybody ON the task may split it, not just whoever set it — the person doing
 * the work is the one who knows what the pieces are, which is the whole shape
 * of *"if CEO is assigning a task to manager then manager can divide that task
 * into multiple subtask"*.
 *
 * @param {Object} opts
 * @param {string} opts.taskId
 * @param {Object} opts.user
 * @param {Array}  opts.items  [{ title, description?, assignee?, openTo?, points?, dueDate?, priority? }]
 */
async function splitTask({ taskId, user, items = [] }) {
  const parent = await Task.findById(taskId);
  if (!parent) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, parent);
  if (!access.actorRoleOn(user, parent)) throw fail('That task is not yours to split.', 403);
  if (parent.kind !== KIND_TASK) throw fail('A request cannot be split into pieces.');
  if (isTerminal(parent.status)) {
    throw fail(`This task is ${statusLabel(parent.status).toLowerCase()} — reopen it first.`);
  }
  if ((Number(parent.depth) || 0) >= MAX_SPLIT_DEPTH - 1) {
    throw fail('This is already a piece of a piece. Set it up as its own task instead.');
  }

  const clean = (items || [])
    .map((it) => ({
      title: String(it?.title || '').trim().slice(0, 300),
      description: String(it?.description || '').trim().slice(0, 5000) || undefined,
      assignee: mongoose.Types.ObjectId.isValid(it?.assignee) ? String(it.assignee) : null,
      openTo: (Array.isArray(it?.openTo) ? it.openTo : [])
        .filter((u) => mongoose.Types.ObjectId.isValid(u)).map(String),
      points: it?.points,
      dueDate: it?.dueDate ? new Date(it.dueDate) : null,
      priority: normalisePriority(it?.priority) || null,
    }))
    .filter((it) => it.title);
  if (!clean.length) throw fail('Give each piece a name.');

  const existing = await Task.countDocuments({ parentTask: parent._id, archived: { $ne: true } });
  if (existing + clean.length > MAX_SUBTASKS) {
    throw fail(`A task can hold ${MAX_SUBTASKS} pieces. Split it into two tasks instead.`);
  }

  // ===== The direction rule, per piece =====
  // Handing a piece UP is the hole the whole task/request split exists to
  // close, so it is refused here by name rather than quietly turned into a
  // request — a "piece" that scores nobody is not what the splitter asked for.
  const named = [...new Set(clean.map((c) => c.assignee).filter(Boolean))];
  if (named.length && !access.isTopOfTree(user)) {
    for (const id of named) {
      const dir = await access.directionOf(user._id, id);
      if (dir === 'UP') {
        throw fail(
          'A piece of a task can only go to your own team or across to a colleague. '
          + 'To ask somebody senior for something, raise a request instead.'
        );
      }
    }
  }

  // ===== The points =====
  const budget = Math.max(0, (Number(parent.points) || 0) - (Number(parent.distributedPoints) || 0));
  const shares = shareOut(clean, budget);

  // Snapshot the owners' names, as everywhere else — a row has to keep reading
  // correctly after somebody leaves.
  const User = require('../models/User');
  const people = named.length
    ? await User.find({ _id: { $in: named } }).select('firstName lastName').lean()
    : [];
  const nameOf = new Map(people.map((p) => [
    String(p._id), [p.firstName, p.lastName].filter(Boolean).join(' ').trim(),
  ]));
  const codeOf = await employeeCodes(named);

  // A piece nobody is named for is OFFERED — to whoever the splitter said, or
  // to their own direct reports, which is what "my team can pick this up" means
  // without anybody having to type a list.
  const fallbackOpenTo = clean.some((c) => !c.assignee && !c.openTo.length)
    ? await access.defaultOpenTo(user._id)
    : [];

  const created = [];
  for (let i = 0; i < clean.length; i += 1) {
    const it = clean[i];
    const child = await Task.create({
      kind: KIND_TASK,
      title: it.title,
      description: it.description,
      category: parent.category,
      company: parent.company,
      createdBy: user._id,
      createdByName: personName(user),
      parentTask: parent._id,
      parentCode: parent.code,
      parentTitle: parent.title,
      depth: (Number(parent.depth) || 0) + 1,
      assignees: it.assignee
        ? [{
          user: it.assignee,
          name: nameOf.get(it.assignee) || '',
          employeeCode: codeOf.get(it.assignee) || '',
        }]
        : [],
      openTo: it.assignee ? [] : (it.openTo.length ? it.openTo : fallbackOpenTo),
      // The splitter hears about every move on every piece without having to be
      // "on" them — that is what holding the parent means.
      loopUsers: [user._id],
      points: shares[i],
      priority: it.priority || parent.priority || DEFAULT_PRIORITY,
      dueDate: it.dueDate || parent.dueDate,
      requiresApproval: parent.requiresApproval !== false,
      reminders: (parent.reminders || []).map((r) => ({
        channel: r.channel, amount: r.amount, unit: r.unit, when: r.when,
      })),
    });
    created.push(child);
  }

  await recomputeParent(parent._id);
  const fresh = await Task.findById(parent._id);

  const update = await TaskUpdate.create({
    task: parent._id,
    kind: 'SPLIT',
    by: user._id,
    byName: personName(user),
    note: created.length === 1
      ? `Split off a piece: ${created[0].title}`
      : `Split into ${created.length} pieces.`,
  });

  notify.taskSplit(fresh, update, user, created)
    .catch((e) => console.error('task notify failed:', e.message));

  return { parent: fresh, children: created, update };
}

/** Employee codes for a set of user ids, as one query. Blank when there is none. */
async function employeeCodes(userIds = []) {
  const out = new Map();
  if (!userIds.length) return out;
  const EmployeeProfile = require('../models/EmployeeProfile');
  const rows = await EmployeeProfile.find({ user: { $in: userIds } })
    .select('user employeeCode').lean();
  for (const r of rows) out.set(String(r.user), r.employeeCode || '');
  return out;
}

/**
 * Take an open piece.
 *
 * The brief's *"they can pick the task"*. The claim is a CONDITIONAL update on
 * the piece still being unclaimed, so two people tapping Claim in the same
 * second cannot both get it — the second is told somebody was quicker rather
 * than silently overwriting the first.
 */
async function claimTask({ taskId, user }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  if (!task.parentTask) throw fail('Only a piece of a task can be picked up.');
  if (isTerminal(task.status)) throw fail('That piece is closed.');
  if ((task.assignees || []).length) {
    throw fail(`${task.assignees[0].name || 'Somebody'} has already picked that up.`, 409);
  }

  const offered = (task.openTo || []).some((u) => String(u._id || u) === String(user._id));
  if (!offered && !access.seesEverything(user)) {
    throw fail('That piece was not offered to you.', 403);
  }

  const now = new Date();
  const codes = await employeeCodes([String(user._id)]);
  const row = {
    user: user._id,
    name: personName(user),
    employeeCode: codes.get(String(user._id)) || '',
    status: STATUS.PENDING,
    // Picking something up IS accepting it. Asking somebody to press Accept
    // straight after they volunteered is the ceremony this module exists to
    // remove.
    acceptance: ACCEPTANCE.ACCEPTED,
    acceptedAt: now,
  };

  const claimed = await Task.updateOne(
    { _id: task._id, assignees: { $size: 0 } },
    { $set: { assignees: [row], assignedTo: user._id, openTo: [], originalAssignees: [user._id] } }
  );
  if (!claimed.matchedCount) {
    throw fail('Somebody else picked that up a moment ago.', 409);
  }

  // Re-read and save so the model's own hooks run over what actually landed.
  const fresh = await Task.findById(task._id);
  await fresh.save();
  if (fresh.parentTask) {
    await recomputeParent(fresh.parentTask).catch(
      (e) => console.error('parent recompute failed:', e.message)
    );
  }

  const update = await TaskUpdate.create({
    task: fresh._id,
    kind: 'CLAIMED',
    by: user._id,
    byName: personName(user),
    note: `${personName(user)} picked this up.`,
  });

  notify.pieceClaimed(fresh, update, user)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task: fresh, update };
}

// ===== Progress =====

/**
 * "How far along are you?"
 *
 * Declared by the doer, never inferred — see config/tasks.PROGRESS_MAX. Only
 * somebody actually on the task may set it: an assigner who could type it would
 * be reporting on work they have not done.
 *
 * MOVING OFF ZERO STARTS THE TASK. Reporting 40% of a job that is still
 * "Pending" is not a state worth having, and making people press Start first is
 * the sort of second click that stops the first one happening at all.
 */
async function setProgress({ taskId, user, progress, note = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const mine = task.assigneeFor(user._id);
  if (!mine) throw fail('Only the person doing this can say how far along it is.', 403);
  if (isTerminal(task.status)) throw fail('That task is closed.');
  if (mine.status === STATUS.COMPLETED) throw fail('Your part of this is already finished.');

  const pct = clampProgress(progress);
  const was = Number(mine.progress) || 0;
  if (pct === was) return { task, update: null, unchanged: true };

  const now = new Date();
  mine.progress = pct;
  mine.progressAt = now;
  if (pct > 0 && mine.status === STATUS.PENDING) {
    mine.status = STATUS.IN_PROGRESS;
    if (!mine.startedAt) mine.startedAt = now;
    if (mine.acceptance === ACCEPTANCE.AWAITING) {
      mine.acceptance = ACCEPTANCE.ACCEPTED;
      mine.acceptedAt = now;
    }
  }
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  if (task.parentTask) {
    await recomputeParent(task.parentTask).catch(
      (e) => console.error('parent recompute failed:', e.message)
    );
  }

  const said = String(note || '').trim();
  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'PROGRESS',
    by: user._id,
    byName: personName(user),
    note: said || `Progress: ${was}% → ${pct}%`,
  });

  notify.progressSet(task, update, user, pct)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, progress: pct };
}

// ===== Asking for more time =====

/**
 * "I will do it, but not by then."
 *
 * The doer's third answer, after accept and decline. It is NOT a status: the
 * work carries on while the answer is awaited, which is the entire difference
 * between asking for more time and downing tools.
 *
 * One un-answered request per person — somebody who could stack three would be
 * asking the same question three times, and the assigner would have to refuse
 * all of them to refuse one.
 */
async function requestExtension({ taskId, user, toDate, reason = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const mine = task.assigneeFor(user._id);
  if (!mine) throw fail('Only the person doing this can ask for more time.', 403);
  if (isTerminal(task.status)) throw fail('That task is closed.');

  const said = String(reason || '').trim();
  if (!said) throw fail('Say why you need longer — the person deciding has nothing else to go on.');

  const when = toDate ? new Date(toDate) : null;
  if (!when || Number.isNaN(when.getTime())) throw fail('Pick the new date you need.');
  if (task.dueDate && when <= new Date(task.dueDate)) {
    throw fail('That date is not later than the current deadline.');
  }

  if (task.pendingExtensionBy(user._id)) {
    throw fail('You have already asked for more time on this. Wait for an answer first.');
  }

  task.extensions.push({
    requestedBy: user._id,
    requestedByName: personName(user),
    requestedAt: new Date(),
    fromDate: task.dueDate,
    toDate: when,
    reason: said.slice(0, 1000),
    status: EXTENSION_STATUS.PENDING,
  });
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const asked = task.extensions[task.extensions.length - 1];
  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'EXTENSION_ASKED',
    by: user._id,
    byName: personName(user),
    note: said,
  });

  notify.extensionAsked(task, update, user, asked)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, extension: asked };
}

/**
 * Yes or no to more time. The assigner's, and nobody else's.
 *
 * Approving MOVES THE DEADLINE and clears the chasing schedule's memory, so the
 * new date gets its own reminders — without that, a task extended past its last
 * reminder would never be chased again.
 *
 * It does NOT touch `completedLate` on anybody who has already handed in. That
 * figure was frozen at submission and re-deriving it here is exactly how a late
 * delivery becomes punctual after the fact.
 */
async function decideExtension({ taskId, requestId, user, approve, note = '' }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);
  if (access.actorRoleOn(user, task) !== 'assigner') {
    throw fail('Only the person who set this task can give more time.', 403);
  }

  const req = (task.extensions || []).id(requestId);
  if (!req) throw fail('That request is no longer there.', 404);
  if (req.status !== EXTENSION_STATUS.PENDING) {
    return { task, update: null, unchanged: true, extension: req };
  }

  const now = new Date();
  req.status = approve ? EXTENSION_STATUS.APPROVED : EXTENSION_STATUS.DECLINED;
  req.decidedBy = user._id;
  req.decidedByName = personName(user);
  req.decidedAt = now;
  req.decisionNote = String(note || '').trim().slice(0, 1000);

  if (approve) {
    task.dueDate = req.toDate;
    task.extensionCount = (task.extensionCount || 0) + 1;
    task.firedReminders = [];
  }
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'EXTENSION_DECIDED',
    by: user._id,
    byName: personName(user),
    note: req.decisionNote || (approve ? 'More time granted.' : 'More time refused.'),
  });

  notify.extensionDecided(task, update, user, req)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, extension: req };
}

// ===== The old subtask endpoints, as adapters =====
//
// An Android build from before 2026-09-22 still calls these three, and an APK
// in somebody's pocket does not update because the server did. They keep
// working, against child tasks — see docs/task-module.md. `subId` is a CHILD
// TASK'S id now; an old client only ever round-trips the id we gave it, so it
// cannot tell.

/** POST /:id/subtasks — an equal split of whatever points are left. */
async function addSubtasks({ taskId, user, items = [] }) {
  const { parent, children, update } = await splitTask({ taskId, user, items });
  return { task: parent, update, added: children.length, children };
}

/** PATCH /:id/subtasks/:childId — tick a piece off, or reopen it. */
async function setSubtaskDone({ taskId, subtaskId, user, done }) {
  const child = await Task.findById(subtaskId);
  if (!child || String(child.parentTask || '') !== String(taskId)) {
    throw fail('That piece is no longer there.', 404);
  }
  const to = done ? STATUS.COMPLETED : STATUS.PENDING;
  if (child.status === to) {
    const parent = await Task.findById(taskId);
    return { task: parent, update: null, unchanged: true };
  }
  await move({
    taskId: child._id,
    user,
    to,
    note: done ? `Finished "${child.title}".` : `Reopened "${child.title}".`,
  });
  const parent = await Task.findById(taskId);
  return {
    task: parent,
    update: null,
    progress: { done: parent.childDoneCount, total: parent.childCount },
  };
}

/** DELETE /:id/subtasks/:childId — archive the piece. */
async function removeSubtask({ taskId, subtaskId, user }) {
  const child = await Task.findById(subtaskId);
  if (!child || String(child.parentTask || '') !== String(taskId)) {
    const parent = await Task.findById(taskId);
    return { task: parent, update: null, unchanged: true };
  }
  if (!access.canDelete(user, child)) {
    throw fail('Only whoever set that piece can remove it.', 403);
  }
  child.archived = true;
  await child.save();
  await recomputeParent(taskId);

  const parent = await Task.findById(taskId);
  const update = await TaskUpdate.create({
    task: parent._id,
    kind: 'SPLIT',
    by: user._id,
    byName: personName(user),
    note: `Removed the piece "${child.title}".`,
  });
  return { task: parent, update };
}

/**
 * Add a remark without moving anything.
 *
 * The same row shape as a status move with `from`/`to` left empty — see
 * models/TaskUpdate for why those are one collection.
 */
async function comment({ taskId, user, note = '', voiceNote = null, files = [], mentions = [] }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const said = String(note || '').trim();
  if (!said && !voiceNote && !files?.length) throw fail('Write something, record something, or attach a file.');

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'COMMENT',
    by: user._id,
    byName: personName(user),
    note: said,
    voiceNote: voiceNote || undefined,
    files: files || [],
    mentions: mentions || [],
  });

  if (files?.length) {
    task.attachments.push(
      ...files.map((f) => ({
        ...f,
        uploadedBy: user._id,
        uploadedByName: personName(user),
        update: update._id,
      }))
    );
  }
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  notify.commented(task, update, user).catch((e) => console.error('task notify failed:', e.message));
  return { task, update };
}

/**
 * Record something the SYSTEM did — a reminder that fired, an occurrence that
 * was minted. Never notified on: the thing being recorded is usually itself a
 * notification, and announcing the announcement is how a feed becomes noise.
 */
async function systemUpdate(taskId, note, kind = 'REMINDER') {
  try {
    return await TaskUpdate.create({
      task: taskId,
      kind,
      byName: 'System',
      note: String(note || '').slice(0, 5000),
      system: true,
    });
  } catch (err) {
    console.error('system task update failed:', err.message);
    return null;
  }
}

/** Is this id even an id? Saves a cast error becoming a 500. */
function validId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

module.exports = {
  move,
  accept,
  decline,
  delegate,
  // Pieces, progress, more time and transfer — the 2026-09-22 additions.
  transferTask,
  splitTask,
  claimTask,
  recomputeParent,
  shareOut,
  setProgress,
  requestExtension,
  decideExtension,
  // The three old subtask endpoints, kept working as adapters onto child tasks
  // so an Android build that predates this change does not break.
  addSubtasks,
  setSubtaskDone,
  removeSubtask,
  comment,
  systemUpdate,
  validId,
  isTerminal,
  fail,
  personName,
};
