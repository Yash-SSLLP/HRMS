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
  STATUS, ACCEPTANCE, transitionFor, isTerminal, statusLabel, KIND_TASK, MAX_SUBTASKS,
} = require('../config/tasks');
const access = require('./taskAccess');
const points = require('./taskPoints');
const notify = require('./taskNotify');

/** Moves an assigner makes ON BEHALF of everybody rather than for themselves. */
const WHOLE_TASK_MOVES = new Set([STATUS.CANCELLED]);

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
    throw fail(
      to === STATUS.COMPLETED
        ? 'Add a note (or a voice note) saying what was done before marking this complete.'
        : 'Add a note (or a voice note) explaining this change.'
    );
  }

  const now = new Date();
  const mine = task.assigneeFor(user._id);
  const wholeTask = WHOLE_TASK_MOVES.has(to) || !mine;

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
      row.status = STATUS.IN_PROGRESS;
      if (!row.startedAt) row.startedAt = now;
    } else if (to === STATUS.COMPLETED) {
      row.status = STATUS.COMPLETED;
      if (!row.startedAt) row.startedAt = now;
      row.completedAt = now;
      // Frozen here, never re-derived: moving the deadline afterwards must not
      // turn a late delivery into a punctual one.
      row.completedLate = Boolean(task.dueDate && now > new Date(task.dueDate));
      const paid = await points.award(task, row, user);
      if (paid) awarded.push({ row, ...paid });
    } else if (to === STATUS.PENDING) {
      if (row.status === STATUS.COMPLETED) await points.reverse(task, row);
      row.status = STATUS.PENDING;
      row.startedAt = undefined;
      row.completedAt = undefined;
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

  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  // ===== 6. The feed =====
  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'STATUS',
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

  return { task, update, awarded };
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

  mine.acceptance = ACCEPTANCE.ACCEPTED;
  mine.acceptedAt = new Date();
  // Accepting after declining is allowed and is the point: a refusal that can
  // be talked round should not need the assigner to reassign the whole task.
  mine.declinedAt = undefined;
  mine.declineReason = undefined;
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'ACCEPTED',
    by: user._id,
    byName: personName(user),
    note: String(note || '').trim() || 'Accepted this.',
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

// ===== Subtasks =====

/**
 * Add pieces to a task.
 *
 * Anybody on the task may split it up, not just whoever set it — the person
 * doing the work is the one who knows what the pieces are. Each piece may name
 * an owner or be left open to everybody on the task (models/Task.subtasks).
 */
async function addSubtasks({ taskId, user, items = [] }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);
  if (!access.actorRoleOn(user, task)) throw fail('That task is not yours to change.', 403);

  const clean = (items || [])
    .map((it) => ({
      title: String(it?.title || '').trim().slice(0, 300),
      assignee: mongoose.Types.ObjectId.isValid(it?.assignee) ? it.assignee : undefined,
    }))
    .filter((it) => it.title);
  if (!clean.length) throw fail('Give each piece a name.');

  if ((task.subtasks?.length || 0) + clean.length > MAX_SUBTASKS) {
    throw fail(`A task can hold ${MAX_SUBTASKS} pieces. Split it into two tasks instead.`);
  }

  // Snapshot the owners' names, as everywhere else — the row has to keep
  // reading after somebody leaves.
  const User = require('../models/User');
  const ids = [...new Set(clean.map((c) => c.assignee).filter(Boolean).map(String))];
  const people = ids.length
    ? await User.find({ _id: { $in: ids } }).select('firstName lastName').lean()
    : [];
  const nameOf = new Map(people.map((p) => [
    String(p._id), [p.firstName, p.lastName].filter(Boolean).join(' ').trim(),
  ]));

  let order = task.subtasks?.length || 0;
  const added = clean.map((c) => ({
    title: c.title,
    assignee: c.assignee,
    assigneeName: c.assignee ? (nameOf.get(String(c.assignee)) || '') : '',
    order: order++,
    addedBy: user._id,
    addedByName: personName(user),
  }));
  task.subtasks.push(...added);
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'SUBTASK',
    by: user._id,
    byName: personName(user),
    note: added.length === 1
      ? `Added a piece: ${added[0].title}${added[0].assigneeName ? ` (${added[0].assigneeName})` : ''}`
      : `Added ${added.length} pieces.`,
  });

  notify.subtasksAdded(task, update, user, added)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, added };
}

/** Tick one off, or un-tick it. Who may do which is services/taskAccess. */
async function setSubtaskDone({ taskId, subtaskId, user, done }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const st = (task.subtasks || []).id(subtaskId);
  if (!st) throw fail('That piece is no longer there.', 404);
  if (!access.canTickSubtask(user, task, st)) {
    throw fail(
      st.assignee
        ? `That piece is ${st.assigneeName || 'somebody else'}'s to tick off.`
        : 'That task is not yours to act on.',
      403
    );
  }
  if (Boolean(st.done) === Boolean(done)) return { task, update: null, unchanged: true };

  st.done = Boolean(done);
  st.doneBy = done ? user._id : undefined;
  st.doneByName = done ? personName(user) : undefined;
  st.doneAt = done ? new Date() : undefined;
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const { done: n, total } = task.subtaskProgress();
  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'SUBTASK',
    by: user._id,
    byName: personName(user),
    note: `${done ? 'Finished' : 'Reopened'} "${st.title}" — ${n} of ${total} done.`,
  });

  notify.subtaskMoved(task, update, user, st)
    .catch((e) => console.error('task notify failed:', e.message));
  return { task, update, progress: { done: n, total } };
}

/** Remove a piece. Whoever added it, or whoever set the task. */
async function removeSubtask({ taskId, subtaskId, user }) {
  const task = await Task.findById(taskId);
  if (!task) throw fail('That task no longer exists.', 404);
  access.assertCanSee(user, task);

  const st = (task.subtasks || []).id(subtaskId);
  if (!st) return { task, update: null, unchanged: true };

  const id = String(user._id);
  const allowed = String(st.addedBy || '') === id
    || String(task.createdBy?._id || task.createdBy || '') === id
    || access.seesEverything(user);
  if (!allowed) throw fail('Only whoever added that piece can remove it.', 403);

  const title = st.title;
  st.deleteOne();
  task.updateCount = (task.updateCount || 0) + 1;
  await task.save();

  const update = await TaskUpdate.create({
    task: task._id,
    kind: 'SUBTASK',
    by: user._id,
    byName: personName(user),
    note: `Removed the piece "${title}".`,
  });
  return { task, update };
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
