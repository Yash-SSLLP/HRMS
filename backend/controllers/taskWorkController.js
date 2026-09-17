/**
 * Task controller, part two — the work itself.
 *
 * Submissions and the evidence they carry, approvals and rejections, the timer,
 * comments, deadline extensions, attachments and the activity trail. Everything
 * that happens BETWEEN a task being handed over and it being finished.
 *
 * Its own file rather than another six hundred lines of taskController.js: that
 * one is about the task as a record, this one is about doing it, and the two
 * have almost no code in common.
 *
 * As there, nothing moves a status by hand — services/taskEngine.transition is
 * the only way a task changes state, so the legal moves, the concurrency guard,
 * the server timestamps and the trail all hold whatever route is being used.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const TaskSubmission = require('../models/TaskSubmission');
const TaskTimeEntry = require('../models/TaskTimeEntry');
const TaskComment = require('../models/TaskComment');
const TaskExtension = require('../models/TaskExtension');
const TaskIncentive = require('../models/TaskIncentive');
const TaskActivity = require('../models/TaskActivity');

const engine = require('../services/taskEngine');
const access = require('../services/taskAccess');
const flow = require('../services/taskWorkflow');
const incentives = require('../services/taskIncentive');
const notify = require('../services/taskNotify');
const storage = require('../services/storage');
const { onCompleted, readPosition, decorate, USER_FIELDS } = require('./taskController');
const { normaliseStatus, canTimeTrack, statusLabel, EVIDENCE_KINDS } = require('../config/taskWorkflow');
const { istDateString } = require('../utils/istDate');

const { httpError, fullName } = engine;

// ===== Evidence =====

/**
 * Put the files on a request into storage and describe them.
 *
 * The BYTES go to GridFS (services/storage.js), which is where every other
 * upload in this portal lives; what comes back is metadata for the document. A
 * kind is worked out from the MIME type, falling back to the extension — an
 * Android file provider that cannot identify a PDF sends
 * application/octet-stream, and matching on the type alone rejected a perfectly
 * good receipt in the expense module for exactly that reason.
 *
 * @param {Array} files - multer's in-memory files
 * @param {object} ctx - { taskId, user }
 * @returns {Promise<Array>} attachment metadata
 */
async function storeEvidence(files, ctx) {
  const out = [];
  for (const file of files || []) {
    const { storagePath, sha256, sizeBytes } = await storage.saveBuffer({
      buffer: file.buffer,
      ownerType: 'task',
      ownerId: String(ctx.taskId),
      originalName: file.originalname,
    });
    out.push({
      name: file.originalname,
      storagePath,
      mimeType: file.mimetype,
      sizeBytes,
      sha256,
      kind: kindOf(file),
      uploadedBy: ctx.user._id,
      uploadedByName: fullName(ctx.user),
      uploadedAt: new Date(),
    });
  }
  return out;
}

/** Which kind of evidence a file is. */
function kindOf(file) {
  const mime = String(file.mimetype || '');
  const name = String(file.originalname || '');
  if (mime.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(name)) return 'photo';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv)$/i.test(name)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|amr)$/i.test(name)) return 'voice';
  return 'document';
}

/**
 * The client sends an evidence field as JSON in a multipart body, so it arrives
 * as a string. Parse it, tolerating both.
 */
function parseJsonField(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// ===== Submission (section 12) =====

/**
 * Hand a task back, with whatever it was required to carry.
 *
 * REFUSED IF INCOMPLETE, and refused with the WHOLE list of what is missing —
 * discovering one missing thing per attempt is how a submission form becomes
 * something people dread. The client shows the same list as it is filled in, but
 * this is where it is enforced: a client-side check is a courtesy, not a rule.
 *
 * A RESUBMISSION IS A NEW ROW. The attempt before it stays exactly as the
 * reviewer saw it (section 53), and `attempt` is what makes "approved first
 * time" answerable — which the incentive rules need.
 *
 * @route POST /api/tasks/:id/submit
 */
const submitTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  const status = normaliseStatus(task.status) || task.status;
  if (!['ACCEPTED', 'IN_PROGRESS', 'REJECTED', 'ASSIGNED'].includes(status)) {
    throw httpError(409, `A task that is ${statusLabel(status).toLowerCase()} cannot be submitted.`);
  }

  const position = await engine.checkGeofence(task, 'submit', readPosition(req.body), req.user._id);

  const evidence = await storeEvidence(req.files, { taskId: task._id, user: req.user });
  const urls = parseJsonField(req.body.urls, []).filter(Boolean).map((u) => String(u).slice(0, 500));
  const fieldValues = parseJsonField(req.body.fieldValues, {});

  const payload = {
    remarks: req.body.remarks,
    evidence,
    urls,
    signature: evidence.find((e) => String(req.body.signatureName || '') === e.name),
    location: position,
    fieldValues,
  };

  const missing = engine.missingRequirements(task, payload);
  if (missing.length) {
    throw httpError(400, `This task cannot be submitted yet. ${missing.join(' ')}`);
  }

  const row = task.assigneeRow(req.user._id);
  const attempt = (row ? row.submissionCount || 0 : 0) + 1;

  const submission = await TaskSubmission.create({
    task: task._id,
    submittedBy: req.user._id,
    submittedByName: fullName(req.user),
    attempt,
    submittedAt: new Date(),
    remarks: req.body.remarks,
    evidence,
    urls,
    location: position || undefined,
    signature: payload.signature,
    checklistSnapshot: (task.checklist || []).map((c) => ({
      text: c.text, done: c.done, mandatory: c.mandatory,
    })),
    fieldValues,
    minutesAtSubmission: row ? row.minutesLogged || 0 : 0,
    stepKey: task.currentStepKey || undefined,
  });

  if (row) {
    row.submissionCount = attempt;
    row.latestSubmission = submission._id;
  }

  // On a multi-assignee task one person submitting is their part being done;
  // the task itself only moves once everybody's part is in.
  const everyoneIn = (() => {
    const people = (task.assignees || []).filter((a) => a.role !== 'Observer');
    if (people.length <= 1) return true;
    return people.every((a) => (String(a.user) === String(req.user._id)
      ? true
      : ['SUBMITTED', 'APPROVED', 'COMPLETED'].includes(normaliseStatus(a.status) || a.status)));
  })();

  let updated = task;
  if (everyoneIn) {
    updated = await engine.transition(task, 'SUBMITTED', req.user, {
      location: position,
      locationEvent: 'submit',
      ip: req.ip,
      message: `${fullName(req.user)} submitted for review${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
    });
    // Re-apply the row changes to the document the conditional update returned.
    const fresh = updated.assigneeRow(req.user._id);
    if (fresh) {
      fresh.submissionCount = attempt;
      fresh.latestSubmission = submission._id;
      fresh.status = 'SUBMITTED';
      fresh.submittedAt = new Date();
    }
    await updated.save();
  } else {
    engine.syncAssigneeStatus(task, 'SUBMITTED', req.user._id);
    await task.save();
    await engine.logActivity({
      task: task._id,
      kind: attempt > 1 ? 'resubmitted' : 'submitted',
      by: req.user,
      message: `${fullName(req.user)} submitted their part`,
      refModel: 'TaskSubmission',
      refId: submission._id,
      location: position,
      ip: req.ip,
    });
  }

  // A rejected task being resubmitted has to be reviewed again, so the step
  // that sent it back is reopened rather than skipped past.
  if (attempt > 1 && (updated.workflowSteps || []).length) {
    await flow.reopenAfterResubmission(updated);
    await updated.save();
  }

  const who = access.audienceOf(updated);
  let reviewers = updated.pendingApprovers && updated.pendingApprovers.length
    ? updated.pendingApprovers
    : who.reviewers;
  if (!reviewers.length) reviewers = await access.managerBench(updated, req.user.scopeCompanyId);
  notify.submitted(updated, reviewers, req.user).catch(() => {});

  res.status(201).json({ task: updated, submission });
});

// ===== Review (section 13) =====

/**
 * Take a submitted task under review, so the assignee can see somebody has it.
 * @route POST /api/tasks/:id/review
 */
const beginReview = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanReview(req, task);
  const updated = await engine.transition(task, 'UNDER_REVIEW', req.user, { ip: req.ip, idempotent: true });
  res.json({ task: updated });
});

/**
 * Approve.
 *
 * WHAT HAPPENS NEXT depends on the route the task is running:
 *   - a workflow step → the decision is recorded on the step, and the workflow
 *     opens whatever comes next. The task only COMPLETES when nothing is left.
 *   - no workflow → approval is the end, and the task completes.
 *
 * @route POST /api/tasks/:id/approve
 */
const approveTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanReview(req, task);

  const note = req.body.note;
  const position = await engine.checkGeofence(task, 'approve', readPosition(req.body), req.user._id);

  // Settle the submissions this decision is about.
  await TaskSubmission.updateMany(
    { task: task._id, status: 'Pending' },
    {
      $set: {
        status: 'Approved',
        reviewedBy: req.user._id,
        reviewedByName: fullName(req.user),
        reviewedAt: new Date(),
        reviewNote: note,
      },
    }
  );

  const runningWorkflow = (task.workflowSteps || []).length > 0;
  let updated;

  if (runningWorkflow && task.currentStepKey) {
    const stepKey = req.body.stepKey || task.currentStepKey;
    const result = await flow.decide(task, stepKey, req.user, 'approved', note);
    await task.save();

    if (result.settled && result.done) {
      updated = await engine.transition(task, 'APPROVED', req.user, { note, location: position, ip: req.ip, idempotent: true });
      updated = await engine.transition(updated, 'COMPLETED', null, { system: true, message: 'Workflow finished' });
      await onCompleted(updated, req.user);
    } else if (result.settled) {
      // More route ahead — the task is being worked again by whoever the next
      // step belongs to, not finished.
      updated = await Task.findById(task._id);
    } else {
      updated = await Task.findById(task._id);
    }
  } else {
    updated = await engine.transition(task, 'APPROVED', req.user, {
      note, location: position, locationEvent: 'approve', ip: req.ip, idempotent: true,
    });
    updated.approvedBy = req.user._id;
    updated.approvalNote = note;
    await updated.save();
    updated = await engine.transition(updated, 'COMPLETED', null, { system: true, message: 'Approved — task complete' });
    await onCompleted(updated, req.user);
  }

  const who = access.audienceOf(updated);
  notify.approved(updated, who.assignees, req.user, note).catch(() => {});

  res.json({ task: updated });
});

/**
 * Send it back.
 *
 * A rejection needs a reason when the task says so (it does by default): a "no"
 * with nothing attached is not something the assignee can act on.
 *
 * @route POST /api/tasks/:id/reject
 */
const rejectTask = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertCanReview(req, task);

  const note = String(req.body.note || req.body.reason || '').trim();
  if (task.rejectionNeedsReason !== false && !note) {
    throw httpError(400, 'Say what needs changing before sending this back.');
  }

  await TaskSubmission.updateMany(
    { task: task._id, status: 'Pending' },
    {
      $set: {
        status: 'Rejected',
        reviewedBy: req.user._id,
        reviewedByName: fullName(req.user),
        reviewedAt: new Date(),
        reviewNote: note,
      },
    }
  );

  if ((task.workflowSteps || []).length && task.currentStepKey) {
    const stepKey = req.body.stepKey || task.currentStepKey;
    const result = await flow.decide(task, stepKey, req.user, 'rejected', note);
    await task.save();
    const step = flow.stepByKey(task, stepKey);
    // 'fail' ends the task rather than sending it back to be redone.
    if (result.rejected && step && step.onReject === 'fail') {
      const cancelled = await engine.transition(task, 'CANCELLED', req.user, { note, ip: req.ip });
      notify.rejected(cancelled, access.audienceOf(cancelled).assignees, req.user, note).catch(() => {});
      return res.json({ task: cancelled });
    }
  }

  const updated = await engine.transition(task, 'REJECTED', req.user, { note, ip: req.ip });
  engine.syncAssigneeStatus(updated, 'REJECTED');
  await updated.save();

  const who = access.audienceOf(updated);
  notify.rejected(updated, who.assignees, req.user, note).catch(() => {});

  res.json({ task: updated });
});

/**
 * The approval inbox (section 13) — everything waiting on this person.
 *
 * Three kinds of waiting, in one list, because from the approver's side they
 * are one job: a workflow step addressed to them, a task they supervise that has
 * been submitted, and a task they created that has been submitted.
 *
 * @route GET /api/tasks/approvals
 */
/**
 * The Mongo filter behind that inbox.
 *
 * Extracted so the sidebar's red count can be `countDocuments` of EXACTLY what
 * the list returns. A badge built from a second, hand-written filter is a badge
 * that says 3 and opens on 11 the first time either one is edited.
 * @param {import('express').Request} req
 * @returns {Promise<Object>} a Mongo filter
 */
async function approvalInboxFilter(req) {
  const me = req.user._id;
  const filter = {
    archived: { $ne: true },
    $or: [
      { pendingApprovers: me },
      { supervisor: me, status: { $in: ['SUBMITTED', 'UNDER_REVIEW', 'Review'] } },
      { manager: me, status: { $in: ['SUBMITTED', 'UNDER_REVIEW', 'Review'] } },
      { createdBy: me, status: { $in: ['SUBMITTED', 'UNDER_REVIEW', 'Review'] } },
    ],
  };
  // An administrator also sees everything submitted inside their wall, so a task
  // whose supervisor is away does not sit unanswered.
  if (access.canManage(req.user)) {
    const vis = await access.visibilityFilter(req);
    filter.$or.push({ ...(vis.$or ? { $or: vis.$or } : {}), status: { $in: ['SUBMITTED', 'UNDER_REVIEW', 'Review'] } });
  }
  return filter;
}

/**
 * How many tasks are waiting on this person to decide — for the sidebar badge.
 * @param {import('express').Request} req
 * @returns {Promise<number>}
 */
async function countMyTaskApprovals(req) {
  return Task.countDocuments(await approvalInboxFilter(req));
}

const myApprovals = asyncHandler(async (req, res) => {
  const filter = await approvalInboxFilter(req);

  const tasks = await Task.find(filter)
    .populate('assignedTo', USER_FIELDS)
    .populate('assignees.user', USER_FIELDS)
    .sort({ submittedAt: 1, dueDate: 1 })
    .limit(200)
    .lean();

  const ids = tasks.map((t) => t._id);
  const submissions = await TaskSubmission.find({ task: { $in: ids }, status: 'Pending' })
    .sort({ submittedAt: -1 })
    .lean();
  const byTask = new Map();
  for (const s of submissions) {
    if (!byTask.has(String(s.task))) byTask.set(String(s.task), []);
    byTask.get(String(s.task)).push(s);
  }

  res.json({
    count: tasks.length,
    tasks: tasks.map((t) => ({
      ...decorate(t),
      submissions: byTask.get(String(t._id)) || [],
      step: (t.workflowSteps || []).find((s) => s.key === t.currentStepKey) || null,
    })),
  });
});

/**
 * Decide one workflow step directly, without going through the task's own
 * approve/reject. For a parallel group, where several steps are open at once and
 * "approve the task" is ambiguous.
 * @route POST /api/tasks/:id/steps/:stepKey/decide
 */
const decideStep = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  const note = req.body.note;

  const step = flow.stepByKey(task, req.params.stepKey);
  if (step && step.requireNote && !String(note || '').trim()) {
    throw httpError(400, `"${step.name}" needs a remark with the decision.`);
  }

  const result = await flow.decide(task, req.params.stepKey, req.user, decision, note);
  await task.save();

  let updated = await Task.findById(task._id);
  if (result.settled && result.rejected) {
    updated = await engine.transition(updated, 'REJECTED', req.user, { note, ip: req.ip, idempotent: true });
    notify.rejected(updated, access.audienceOf(updated).assignees, req.user, note).catch(() => {});
  } else if (result.settled && result.done) {
    updated = await engine.transition(updated, 'APPROVED', req.user, { note, ip: req.ip, idempotent: true });
    updated = await engine.transition(updated, 'COMPLETED', null, { system: true, message: 'Workflow finished' });
    await onCompleted(updated, req.user);
    notify.approved(updated, access.audienceOf(updated).assignees, req.user, note).catch(() => {});
  }

  res.json({ task: updated, workflow: flow.outline(updated) });
});

// ===== Time tracking (section 11) =====

/**
 * Start the clock on a task.
 *
 * ONE TIMER AT A TIME, and it is the DATABASE that says so — a partial unique
 * index on TaskTimeEntry, so two phones starting a timer in the same second
 * cannot both win however this handler is ordered. The duplicate-key error is
 * turned into a sentence naming the task already running, which is what the
 * person actually needs to know.
 *
 * @route POST /api/tasks/:id/timer/start
 */
const startTimer = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  const status = normaliseStatus(task.status) || task.status;
  if (!canTimeTrack(status)) {
    throw httpError(409, `The clock does not run on a task that is ${statusLabel(status).toLowerCase()}.`);
  }

  let entry;
  try {
    entry = await TaskTimeEntry.create({
      task: task._id,
      user: req.user._id,
      userName: fullName(req.user),
      startedAt: new Date(),
      source: 'timer',
      status: 'running',
      note: req.body.note,
      dayKey: istDateString(new Date()),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const open = await TaskTimeEntry.findOne({ user: req.user._id, status: { $in: ['running', 'paused'] } })
        .populate('task', 'title code')
        .lean();
      throw httpError(
        409,
        open && open.task
          ? `Your clock is already running on "${open.task.title}". Stop that one first.`
          : 'You already have a timer running. Stop it first.'
      );
    }
    throw err;
  }

  // Starting the clock starts the task, if it had not started already.
  if (['ASSIGNED', 'ACCEPTED'].includes(status)) {
    try {
      const moved = await engine.transition(task, 'IN_PROGRESS', req.user, { ip: req.ip, idempotent: true });
      engine.syncAssigneeStatus(moved, 'IN_PROGRESS', req.user._id);
      await moved.save();
    } catch (err) {
      // A task that could not move (a dependency, a race) still gets its timer —
      // the person IS working, and refusing to record that helps nobody.
      console.error('Timer started but task could not be moved:', err.message);
    }
  }

  await engine.logActivity({
    task: task._id, kind: 'timeEntry', by: req.user,
    message: `${fullName(req.user)} started the clock`, ip: req.ip,
    refModel: 'TaskTimeEntry', refId: entry._id,
  });

  res.status(201).json({ entry });
});

/**
 * Pause, resume or stop the running timer.
 *
 * Pausing does NOT close the entry — a person who starts at 10:00, takes a
 * fifteen-minute call and stops at 11:30 did one stretch of work of 1h 15m, not
 * two of 45 and 30 minutes, and the break is a fact about that stretch.
 *
 * @route POST /api/tasks/:id/timer/:action
 */
const controlTimer = asyncHandler(async (req, res) => {
  const { action } = req.params;
  const entry = await TaskTimeEntry.findOne({
    task: req.params.id,
    user: req.user._id,
    status: { $in: ['running', 'paused'] },
  });
  if (!entry) throw httpError(404, 'You have no timer running on this task.');

  const now = new Date();
  switch (action) {
    case 'pause': {
      if (entry.status === 'paused') throw httpError(409, 'The clock is already paused.');
      entry.pauses.push({ at: now });
      entry.status = 'paused';
      break;
    }
    case 'resume': {
      if (entry.status !== 'paused') throw httpError(409, 'The clock is not paused.');
      const open = entry.pauses[entry.pauses.length - 1];
      if (open && !open.until) open.until = now;
      entry.status = 'running';
      break;
    }
    case 'stop': {
      const open = entry.pauses[entry.pauses.length - 1];
      if (open && !open.until) open.until = now;
      entry.endedAt = now;
      entry.status = 'stopped';
      if (req.body.note) entry.note = String(req.body.note).slice(0, 500);
      break;
    }
    default:
      throw httpError(400, `"${action}" is not something the timer does.`);
  }

  await entry.save();
  if (action === 'stop') {
    await engine.recomputeRollups(req.params.id);
    await engine.logActivity({
      task: req.params.id, kind: 'timeEntry', by: req.user,
      message: `${fullName(req.user)} stopped the clock — ${formatMinutes(entry.activeMinutes)}`,
      refModel: 'TaskTimeEntry', refId: entry._id, ip: req.ip,
    });
  }

  res.json({ entry });
});

/** "1h 15m" — how long, in words. */
function formatMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
}

/**
 * Record time that has already been worked.
 *
 * A typed figure is a CLAIM, not a recording, so it can be made to need a
 * supervisor's yes — the task's own setting, defaulting to "needed when the task
 * pays an incentive", because that is when the figure is worth something.
 *
 * @route POST /api/tasks/:id/time-entry
 */
const addManualTime = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });

  // Somebody else's time can only be recorded by somebody who manages the task.
  const forUser = req.body.user && String(req.body.user) !== String(req.user._id)
    ? req.body.user
    : req.user._id;
  if (String(forUser) !== String(req.user._id)) access.assertCanEdit(req, task);
  else access.assertIsAssignee(req, task);

  const startedAt = new Date(req.body.startedAt);
  if (Number.isNaN(startedAt.getTime())) throw httpError(400, 'Say when the work started.');

  let endedAt = req.body.endedAt ? new Date(req.body.endedAt) : null;
  if (!endedAt && req.body.minutes) {
    endedAt = new Date(startedAt.getTime() + Number(req.body.minutes) * 60000);
  }
  if (!endedAt || Number.isNaN(endedAt.getTime())) throw httpError(400, 'Say when it ended, or how long it took.');
  if (endedAt <= startedAt) throw httpError(400, 'The end has to be after the start.');
  if (startedAt > new Date()) throw httpError(400, 'That is in the future.');

  const breakMinutes = Math.max(0, Number(req.body.breakMinutes) || 0);
  const pauses = breakMinutes
    ? [{ at: startedAt, until: new Date(startedAt.getTime() + breakMinutes * 60000) }]
    : [];

  // An incentive makes the hours worth something, so they get checked.
  const needsApproval = req.body.needsApproval != null
    ? !!req.body.needsApproval
    : !!(task.incentive && task.incentive.enabled);

  const entry = await TaskTimeEntry.create({
    task: task._id,
    user: forUser,
    userName: String(forUser) === String(req.user._id) ? fullName(req.user) : undefined,
    startedAt,
    endedAt,
    pauses,
    source: 'manual',
    status: 'stopped',
    note: req.body.note,
    dayKey: istDateString(startedAt),
    approvalStatus: needsApproval ? 'Pending' : null,
  });

  await engine.recomputeRollups(task._id);
  await engine.logActivity({
    task: task._id, kind: 'timeEntry', by: req.user,
    message: `${fullName(req.user)} recorded ${formatMinutes(entry.activeMinutes)} of work`,
    note: req.body.note, refModel: 'TaskTimeEntry', refId: entry._id, ip: req.ip,
  });

  res.status(201).json({ entry });
});

/**
 * Approve or reject a claimed time entry.
 * @route PATCH /api/tasks/time-entries/:entryId
 */
const decideTimeEntry = asyncHandler(async (req, res) => {
  const entry = await TaskTimeEntry.findById(req.params.entryId);
  if (!entry) throw httpError(404, 'That time entry does not exist.');
  const task = await access.loadVisibleTask(req, String(entry.task), { populate: false });
  access.assertCanReview(req, task);

  if (String(entry.user) === String(req.user._id)) {
    throw httpError(403, 'You cannot approve your own time.');
  }
  if (entry.approvalStatus !== 'Pending') {
    throw httpError(409, `That entry has already been ${String(entry.approvalStatus || 'settled').toLowerCase()}.`);
  }

  const approved = req.body.decision !== 'reject';
  entry.approvalStatus = approved ? 'Approved' : 'Rejected';
  entry.approvedBy = req.user._id;
  entry.approvedAt = new Date();
  entry.approvalNote = req.body.note;
  await entry.save();

  await engine.recomputeRollups(task._id);
  await engine.logActivity({
    task: task._id,
    kind: approved ? 'timeApproved' : 'timeRejected',
    by: req.user,
    message: `${fullName(req.user)} ${approved ? 'approved' : 'rejected'} ${formatMinutes(entry.activeMinutes)} claimed by ${entry.userName || 'an employee'}`,
    note: req.body.note,
    refModel: 'TaskTimeEntry', refId: entry._id, ip: req.ip,
  });

  res.json({ entry });
});

/**
 * A task's timesheet — every entry, and the totals by person and by day.
 * @route GET /api/tasks/:id/timesheet
 */
const taskTimesheet = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const entries = await TaskTimeEntry.find({ task: task._id })
    .populate('user', 'firstName lastName')
    .sort({ startedAt: -1 })
    .lean();

  const byPerson = new Map();
  const byDay = new Map();
  for (const e of entries) {
    if (e.approvalStatus === 'Rejected') continue;
    // A running entry has no end, so its figure has to be measured live rather
    // than read off the row.
    const mins = e.status === 'stopped'
      ? e.activeMinutes
      : TaskTimeEntry.measure(e).activeMinutes;
    const key = String(e.user?._id || e.user);
    byPerson.set(key, {
      user: e.user,
      minutes: (byPerson.get(key)?.minutes || 0) + mins,
    });
    byDay.set(e.dayKey, (byDay.get(e.dayKey) || 0) + mins);
  }

  const total = [...byPerson.values()].reduce((t, p) => t + p.minutes, 0);
  res.json({
    entries: entries.map((e) => ({
      ...e,
      liveMinutes: e.status === 'stopped' ? e.activeMinutes : TaskTimeEntry.measure(e).activeMinutes,
    })),
    byPerson: [...byPerson.values()],
    byDay: [...byDay.entries()].map(([day, minutes]) => ({ day, minutes })).sort((a, b) => a.day.localeCompare(b.day)),
    totalMinutes: total,
    estimatedMinutes: task.estimatedMinutes || 0,
  });
});

/**
 * The signed-in person's running timer, wherever it is.
 * @route GET /api/tasks/me/timer
 */
const myTimer = asyncHandler(async (req, res) => {
  const entry = await TaskTimeEntry.findOne({
    user: req.user._id,
    status: { $in: ['running', 'paused'] },
  }).populate('task', 'title code status').lean();
  if (!entry) return res.json({ entry: null });
  res.json({ entry: { ...entry, liveMinutes: TaskTimeEntry.measure(entry).activeMinutes } });
});

/**
 * The signed-in person's own timesheet across every task, by day.
 * @route GET /api/tasks/me/timesheet
 */
const myTimesheet = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const filter = { user: req.user._id };
  if (from || to) {
    filter.dayKey = {};
    if (from) filter.dayKey.$gte = String(from);
    if (to) filter.dayKey.$lte = String(to);
  }
  const entries = await TaskTimeEntry.find(filter)
    .populate('task', 'title code status')
    .sort({ startedAt: -1 })
    .limit(500)
    .lean();

  const byDay = new Map();
  for (const e of entries) {
    if (e.approvalStatus === 'Rejected') continue;
    const mins = e.status === 'stopped' ? e.activeMinutes : TaskTimeEntry.measure(e).activeMinutes;
    byDay.set(e.dayKey, (byDay.get(e.dayKey) || 0) + mins);
  }

  res.json({
    entries,
    byDay: [...byDay.entries()].map(([day, minutes]) => ({ day, minutes })).sort((a, b) => b.day.localeCompare(a.day)),
    totalMinutes: [...byDay.values()].reduce((t, m) => t + m, 0),
  });
});

// ===== Comments (section 14) =====

/**
 * Add a remark.
 * @route POST /api/tasks/:id/comments
 */
const addComment = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });

  const body = String(req.body.body || '').trim();
  if (!body) throw httpError(400, 'A comment needs something in it.');

  // Only a reviewer may leave a note the assignee cannot see.
  const internal = !!req.body.internal;
  if (internal && !task.isReviewer(req.user._id) && !access.canManage(req.user)) {
    throw httpError(403, 'Only a reviewer can leave an internal note.');
  }

  const attachments = await storeEvidence(req.files, { taskId: task._id, user: req.user });
  const mentions = (parseJsonField(req.body.mentions, []) || [])
    .filter((m) => mongoose.isValidObjectId(String(m)));

  const comment = await TaskComment.create({
    task: task._id,
    author: req.user._id,
    authorName: fullName(req.user),
    authorRole: req.user.role,
    body,
    context: req.body.context || 'general',
    attachments,
    mentions,
    internal,
    location: readPosition(req.body) || undefined,
  });

  task.commentCount = (task.commentCount || 0) + 1;
  await task.save();

  await engine.logActivity({
    task: task._id, kind: 'comment', by: req.user,
    message: `${fullName(req.user)} commented`, note: body.slice(0, 400),
    refModel: 'TaskComment', refId: comment._id, ip: req.ip,
  });

  const who = access.audienceOf(task);
  notify.commented(task, { assigneeIds: who.assignees, reviewerIds: who.reviewers }, req.user, body, internal)
    .catch(() => {});
  if (mentions.length) notify.mentioned(task, mentions, req.user, body).catch(() => {});

  res.status(201).json({ comment });
});

/**
 * A task's comments, oldest first. Internal notes are filtered out for anyone
 * who is not a reviewer.
 * @route GET /api/tasks/:id/comments
 */
const listComments = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const canSeeInternal = task.isReviewer(req.user._id) || access.canManage(req.user);
  const filter = { task: task._id, deletedAt: null };
  if (!canSeeInternal) filter.internal = { $ne: true };

  const comments = await TaskComment.find(filter)
    .populate('author', 'firstName lastName photo role')
    .sort({ createdAt: 1 })
    .lean();
  res.json({ count: comments.length, comments });
});

// ===== Extensions (section 21) =====

/**
 * Ask for more time.
 * @route POST /api/tasks/:id/extensions
 */
const requestExtension = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  access.assertIsAssignee(req, task);

  const requested = new Date(req.body.requestedDueDate || req.body.dueDate);
  if (Number.isNaN(requested.getTime())) throw httpError(400, 'Say what date you need.');
  if (task.dueDate && requested <= new Date(task.dueDate)) {
    throw httpError(400, 'An extension has to be later than the current deadline.');
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw httpError(400, 'Say why you need longer.');

  const open = await TaskExtension.findOne({ task: task._id, status: 'Pending' });
  if (open) throw httpError(409, 'You already have an extension request waiting on this task.');

  const attachments = await storeEvidence(req.files, { taskId: task._id, user: req.user });
  const sequence = (task.extensionCount || 0) + 1;

  const ext = await TaskExtension.create({
    task: task._id,
    requestedBy: req.user._id,
    requestedByName: fullName(req.user),
    currentDueDate: task.dueDate,
    requestedDueDate: requested,
    reason,
    attachments,
    sequence,
  });

  await engine.logActivity({
    task: task._id, kind: 'extensionRequested', by: req.user,
    message: `${fullName(req.user)} asked to move the deadline to ${requested.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`,
    note: reason, field: 'dueDate', from: task.dueDate, to: requested,
    refModel: 'TaskExtension', refId: ext._id, ip: req.ip,
  });

  let approvers = access.audienceOf(task).reviewers;
  if (!approvers.length) approvers = await access.managerBench(task, req.user.scopeCompanyId);
  notify.extensionRequested(task, approvers, req.user, requested).catch(() => {});

  res.status(201).json({ extension: ext });
});

/**
 * Grant or refuse an extension.
 *
 * The approver may grant a DIFFERENT date from the one asked for — three days
 * when five were requested — which is why the row keeps all three dates. The
 * task's `dueDate` moves; `originalDueDate` never does (section 53).
 *
 * @route PATCH /api/tasks/extensions/:extensionId
 */
const decideExtension = asyncHandler(async (req, res) => {
  const ext = await TaskExtension.findById(req.params.extensionId);
  if (!ext) throw httpError(404, 'That request does not exist.');
  if (ext.status !== 'Pending') {
    throw httpError(409, `That request has already been ${ext.status.toLowerCase()}.`);
  }

  const task = await access.loadVisibleTask(req, String(ext.task), { populate: false });
  access.assertCanReview(req, task);
  if (String(ext.requestedBy) === String(req.user._id)) {
    throw httpError(403, 'You cannot grant your own extension.');
  }

  const approved = req.body.decision !== 'reject';
  const note = req.body.note;

  if (approved) {
    const granted = req.body.approvedDueDate ? new Date(req.body.approvedDueDate) : ext.requestedDueDate;
    if (Number.isNaN(granted.getTime())) throw httpError(400, 'That is not a date.');

    ext.approvedDueDate = granted;
    ext.status = 'Approved';

    const was = task.dueDate;
    task.dueDate = granted;
    task.extensionCount = (task.extensionCount || 0) + 1;
    // A task that was already late and has been given more time is no longer
    // overdue — but `firstOverdueAt` STAYS, because it did miss a deadline and
    // an extension must not quietly rewrite that.
    task.firedReminders = (task.firedReminders || []).filter((k) => !k.startsWith('due:') && !k.startsWith('over:'));
    await task.save();

    await engine.logActivity({
      task: task._id, kind: 'extensionApproved', by: req.user,
      message: `${fullName(req.user)} moved the deadline to ${granted.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`,
      note, field: 'dueDate', from: was, to: granted,
      refModel: 'TaskExtension', refId: ext._id, ip: req.ip,
    });
  } else {
    ext.status = 'Rejected';
    await engine.logActivity({
      task: task._id, kind: 'extensionRejected', by: req.user,
      message: `${fullName(req.user)} did not extend the deadline`, note,
      refModel: 'TaskExtension', refId: ext._id, ip: req.ip,
    });
  }

  ext.decidedBy = req.user._id;
  ext.decidedByName = fullName(req.user);
  ext.decidedAt = new Date();
  ext.decisionNote = note;
  await ext.save();

  notify.extensionDecided(task, [ext.requestedBy], approved, ext.approvedDueDate, req.user, note).catch(() => {});

  res.json({ extension: ext, task });
});

// ===== Attachments =====

/**
 * Hang files on the task itself (as opposed to on a submission).
 * @route POST /api/tasks/:id/attachments
 */
const addAttachments = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  if (!task.isAssignee(req.user._id) && !task.isReviewer(req.user._id) && !access.canManage(req.user)) {
    throw httpError(403, 'Only somebody involved in this task can add files to it.');
  }
  if (!req.files || !req.files.length) throw httpError(400, 'No file was uploaded.');

  const files = await storeEvidence(req.files, { taskId: task._id, user: req.user });
  task.attachments.push(...files);
  await task.save();

  await engine.logActivity({
    task: task._id, kind: 'attachment', by: req.user,
    message: `${fullName(req.user)} attached ${files.length} file${files.length === 1 ? '' : 's'}`,
    note: files.map((f) => f.name).join(', '), ip: req.ip,
  });

  res.status(201).json({ attachments: files });
});

/**
 * Stream one attachment or piece of evidence back.
 *
 * Authorisation is the TASK's — anyone who may see the task may see its files,
 * nobody else. A storagePath is not a capability: the file is looked up by id
 * ON this task rather than served from whatever path a client sends, so a
 * guessed or poisoned string reaches nothing.
 *
 * @route GET /api/tasks/:id/files/:fileId
 */
const downloadFile = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const { fileId } = req.params;

  let file = (task.attachments || []).id(fileId);
  if (!file) {
    for (const item of task.checklist || []) {
      const hit = (item.evidence || []).id(fileId);
      if (hit) { file = hit; break; }
    }
  }
  if (!file) {
    const sub = await TaskSubmission.findOne({
      task: task._id,
      $or: [{ 'evidence._id': fileId }, { 'signature._id': fileId }],
    });
    if (sub) {
      file = (sub.evidence || []).id(fileId)
        || (sub.signature && String(sub.signature._id) === String(fileId) ? sub.signature : null);
    }
  }
  if (!file) {
    const comment = await TaskComment.findOne({ task: task._id, 'attachments._id': fileId });
    if (comment) file = (comment.attachments || []).id(fileId);
  }
  if (!file) {
    const ext = await TaskExtension.findOne({ task: task._id, 'attachments._id': fileId });
    if (ext) file = (ext.attachments || []).id(fileId);
  }

  if (!file) throw httpError(404, 'That file is not on this task.');

  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.name || 'file')}"`
  );
  await storage.streamTo(file.storagePath, res);
});

// ===== Trail (section 30) =====

/**
 * A task's history, oldest first.
 * @route GET /api/tasks/:id/activity
 */
const taskActivity = asyncHandler(async (req, res) => {
  const task = await access.loadVisibleTask(req, req.params.id, { populate: false });
  const { page = 1, limit = 200 } = req.query;
  const perPage = Math.min(500, Math.max(1, Number(limit)));
  const [rows, total] = await Promise.all([
    TaskActivity.find({ task: task._id })
      .sort({ at: 1 })
      .skip((Math.max(1, Number(page)) - 1) * perPage)
      .limit(perPage)
      .lean(),
    TaskActivity.countDocuments({ task: task._id }),
  ]);
  res.json({ count: rows.length, total, activity: rows });
});

// ===== Incentive decisions (section 25) =====

/**
 * Task incentives waiting to be sanctioned.
 * @route GET /api/tasks/incentives
 */
const listIncentives = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  else filter.status = 'Pending';

  // The company wall applies to money as much as to people.
  const { viewerCompanyScope } = require('../utils/employeeScope');
  const scope = viewerCompanyScope(req);
  if (scope) {
    filter.company = { $in: [...scope.ids.map((id) => new mongoose.Types.ObjectId(id)), null] };
  }

  const rows = await TaskIncentive.find(filter)
    .populate('user', 'firstName lastName')
    .populate('task', 'title code status completedAt dueDate')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();

  const pendingPoints = rows
    .filter((r) => r.status === 'Pending')
    .reduce((t, r) => t + (r.points || 0), 0);

  res.json({ count: rows.length, incentives: rows, pendingPoints: Math.round(pendingPoints * 100) / 100 });
});

/**
 * Sanction or refuse one.
 *
 * Approving writes an IncentiveCredit — the points join the same company-wide
 * pool as every other incentive, and from that moment nothing distinguishes
 * them. Nothing here touches payroll.
 *
 * @route PATCH /api/tasks/incentives/:awardId
 */
const decideIncentive = asyncHandler(async (req, res) => {
  const award = await TaskIncentive.findById(req.params.awardId);
  if (!award) throw httpError(404, 'That incentive does not exist.');

  const approved = req.body.decision !== 'reject';
  const updated = approved
    ? await incentives.approveAward(award, req.user, { points: req.body.points, note: req.body.note })
    : await incentives.rejectAward(award, req.user, req.body.note);

  res.json({ incentive: updated });
});

module.exports = {
  countMyTaskApprovals,
  submitTask,
  beginReview,
  approveTask,
  rejectTask,
  myApprovals,
  decideStep,
  startTimer,
  controlTimer,
  addManualTime,
  decideTimeEntry,
  taskTimesheet,
  myTimer,
  myTimesheet,
  addComment,
  listComments,
  requestExtension,
  decideExtension,
  addAttachments,
  downloadFile,
  taskActivity,
  listIncentives,
  decideIncentive,
  storeEvidence,
  formatMinutes,
};
