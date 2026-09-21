/**
 * Tasks — the whole API.
 *
 * REWRITTEN 2026-09-21, replacing taskController (1375 lines), taskWorkController
 * (1158) and taskWorkflowController (485). Three controllers existed because the
 * module had three vocabularies: the task, the work done on it, and the workflow
 * it ran through. There is now one of each, so there is one file.
 *
 * The shape of every list endpoint is the same and is worth stating once:
 *
 *   scope    which pile     — mine | delegated | loop | all | requests
 *   range    which window   — today | yesterday | week | month | nextWeek | all | custom
 *   filters  category, assignedTo, assignedBy, frequency, priority, status, q
 *
 * …and every one of them runs ON THE SERVER. The brief's app shows a live
 * counter row above the list (Overdue / Pending / In Progress / Completed, and
 * Completed split In Time / Delayed) which must agree with the rows below it, so
 * counts and rows come from ONE filter built once — `buildQuery` — and the
 * counters are an aggregation over that same filter rather than a tally of the
 * page that happens to be loaded.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const TaskCategory = require('../models/TaskCategory');
const TaskTemplate = require('../models/TaskTemplate');
const RecurringTask = require('../models/RecurringTask');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

const engine = require('../services/taskEngine');
const access = require('../services/taskAccess');
const notify = require('../services/taskNotify');
const points = require('../services/taskPoints');
const storage = require('../services/storage');

const { pickableUserFilter } = require('../utils/peoplePicker');
const { viewerCompanyScope } = require('../utils/employeeScope');
const {
  KIND_TASK, KIND_REQUEST, TASK_KINDS, STATUS, TASK_STATUS, TASK_PRIORITY,
  DEFAULT_PRIORITY, FREQUENCY, FREQUENCIES, FREQUENCY_LABELS, WEEKDAYS,
  REMINDER_CHANNELS, REMINDER_UNITS, REMINDER_WHENS, REMINDER_CHANNEL_LABELS,
  MAX_TASK_POINTS, evidenceKindFor, statusLabel, isOverdue, isTerminal,
  isDeclined, isAwaitingAcceptance, ACCEPTANCE_LABELS,
} = require('../config/tasks');

// ===== Small shared helpers =====

const oid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);
const personName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();

function bad(res, message, status = 400) {
  res.status(status);
  throw new Error(message);
}

/** A comma-separated query parameter as a clean array. */
function listParam(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The date window the chip bar asks for.
 *
 * Computed in the SERVER's timezone, which is the portal's — a browser in
 * another zone asking for "today" means the company's today, not its own.
 * Returns null for "all time", which is not a filter at all.
 */
function rangeWindow(range, fromRaw, toRaw) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = startOfDay(now);

  switch (range) {
    case 'today': return { $gte: today, $lt: addDays(today, 1) };
    case 'yesterday': return { $gte: addDays(today, -1), $lt: today };
    case 'week': {
      // Monday-first, matching how the rest of the portal reads a week.
      const dow = (today.getDay() + 6) % 7;
      const monday = addDays(today, -dow);
      return { $gte: monday, $lt: addDays(monday, 7) };
    }
    case 'nextWeek': {
      const dow = (today.getDay() + 6) % 7;
      const monday = addDays(today, -dow + 7);
      return { $gte: monday, $lt: addDays(monday, 7) };
    }
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { $gte: first, $lt: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
    }
    case 'custom': {
      const from = fromRaw ? new Date(fromRaw) : null;
      const to = toRaw ? new Date(toRaw) : null;
      if (!from && !to) return null;
      const w = {};
      if (from && !Number.isNaN(from.getTime())) w.$gte = startOfDay(from);
      if (to && !Number.isNaN(to.getTime())) w.$lt = addDays(startOfDay(to), 1);
      return Object.keys(w).length ? w : null;
    }
    default: return null; // 'all'
  }
}

/**
 * ONE filter, used by the list AND by the counters above it.
 *
 * If these two were built separately they would drift, and a counter that
 * disagrees with the rows underneath it is worse than no counter — it makes
 * people stop trusting the page.
 */
async function buildQuery(req, overrides = {}) {
  const {
    scope = 'all', range = 'all', from, to,
    category, assignedTo, assignedBy, frequency, priority, status, q, kind, overdue, late,
    // `overrides` lets a caller pin one parameter without faking a request
    // object. Spreading an Express `req` copies own properties only and quietly
    // loses `user`, which is how the dashboard first lost its company wall.
  } = { ...req.query, ...overrides };

  const filter = await access.visibleFilter(req, scope === 'requests' ? 'all' : scope);
  const and = [filter];

  // A request is its own pile: it never appears among the tasks, because "what
  // is on my plate" and "what have I asked for" are different questions.
  if (scope === 'requests') and.push({ kind: KIND_REQUEST });
  else if (kind && TASK_KINDS.includes(kind)) and.push({ kind });
  else and.push({ kind: KIND_TASK });

  const window = rangeWindow(range, from, to);
  // The window applies to the DEADLINE, which is what the chip bar means: "this
  // week" is the work due this week, not the work created this week.
  if (window) and.push({ dueDate: window });

  const cats = listParam(category);
  if (cats.length) and.push({ category: { $in: cats } });

  const doers = listParam(assignedTo).map(oid).filter(Boolean);
  if (doers.length) and.push({ 'assignees.user': { $in: doers } });

  const setters = listParam(assignedBy).map(oid).filter(Boolean);
  if (setters.length) and.push({ createdBy: { $in: setters } });

  const freqs = listParam(frequency).filter((f) => FREQUENCIES.includes(f));
  if (freqs.length) and.push({ 'repeat.frequency': { $in: freqs } });

  const prios = listParam(priority).filter((p) => TASK_PRIORITY.includes(p));
  if (prios.length) and.push({ priority: { $in: prios } });

  const states = listParam(status).filter((s) => TASK_STATUS.includes(s));
  if (states.length) and.push({ status: { $in: states } });

  // Overdue is derived, so it is a query rather than a status: open, and past
  // its deadline. Asking for it alongside `status=COMPLETED` correctly returns
  // nothing, which is the honest answer.
  if (overdue === 'true' || overdue === '1') {
    and.push({ status: { $in: [STATUS.PENDING, STATUS.IN_PROGRESS] }, dueDate: { $lt: new Date() } });
  }

  // The In Time / Delayed split, for when somebody clicks one of those two
  // figures. Reads the FROZEN flag rather than comparing dates, so it returns
  // exactly the rows the counter counted — a task whose deadline was moved
  // after it was finished must not appear under one figure and be counted
  // under the other. `$ne: true` rather than `false`, because rows written
  // before the field existed have no value at all and were on time.
  if (late === 'true' || late === '1') and.push({ completedLate: true });
  else if (late === 'false' || late === '0') and.push({ completedLate: { $ne: true } });

  const search = String(q || '').trim();
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ title: rx }, { description: rx }, { code: rx }, { category: rx }] });
  }

  return and.length === 1 ? and[0] : { $and: and };
}

/**
 * The counter row: the figures above every list.
 *
 * One aggregation over the SAME filter the rows use, and the boxes DO NOT
 * OVERLAP — every task is counted in exactly one of them, so they sum to the
 * total and the row can be trusted. Overdue wins over Pending and In Progress:
 * a task that is late is late, and listing it under both makes the red figure
 * meaningless and the arithmetic wrong.
 *
 *   overdue      open (pending or in progress) and past its deadline
 *   pending      not started, not late
 *   inProgress   started, not late
 *   completed    done — split into inTime / delayed
 *   cancelled    called off
 *
 * The In Time / Delayed split reads the FROZEN `completedLate` flag rather than
 * comparing dates now: the deadline may have been moved after the fact, and a
 * late delivery must not become punctual because somebody granted an extension
 * afterwards (see models/Task).
 */
async function countersFor(filter) {
  const now = new Date();
  // "Open and past its deadline" — spelled once, used three times below.
  const late = {
    $and: [
      { $in: ['$status', [STATUS.PENDING, STATUS.IN_PROGRESS]] },
      { $ne: ['$dueDate', null] },
      { $lt: ['$dueDate', now] },
    ],
  };
  const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

  const rows = await Task.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        overdue: countIf(late),
        pending: countIf({ $and: [{ $eq: ['$status', STATUS.PENDING] }, { $not: late }] }),
        inProgress: countIf({ $and: [{ $eq: ['$status', STATUS.IN_PROGRESS] }, { $not: late }] }),
        completed: countIf({ $eq: ['$status', STATUS.COMPLETED] }),
        cancelled: countIf({ $eq: ['$status', STATUS.CANCELLED] }),
        inTime: countIf({
          $and: [{ $eq: ['$status', STATUS.COMPLETED] }, { $ne: ['$completedLate', true] }],
        }),
        delayed: countIf({
          $and: [{ $eq: ['$status', STATUS.COMPLETED] }, { $eq: ['$completedLate', true] }],
        }),
      },
    },
  ]);
  const c = rows[0] || {};
  return {
    total: c.total || 0,
    overdue: c.overdue || 0,
    pending: c.pending || 0,
    inProgress: c.inProgress || 0,
    completed: c.completed || 0,
    inTime: c.inTime || 0,
    delayed: c.delayed || 0,
    cancelled: c.cancelled || 0,
  };
}

/** What a list row needs, and nothing more. Keeps a 200-row page small. */
const LIST_FIELDS = 'code kind title category priority status points dueDate startDate '
  + 'completedAt completedLate createdBy createdByName assignedTo assignees loopUsers '
  + 'repeat voiceNote attachments links reminders updateCount stateNote createdAt linkedTask '
  // A row has to show "2 of 5 done" and "not yet accepted" without a second
  // query, so the pieces and the delegation trail come down with the list.
  + 'subtasks delegations originalAssignees';

/**
 * Decorate a lean row with the derived bits every client would compute anyway.
 *
 * Everything here is DERIVED, never stored — `overdue`, `declined` and the
 * subtask progress all change without anybody writing to the row, and a stored
 * copy would go stale the moment a clock ticked or somebody was added.
 */
function decorate(row) {
  const subtasks = row.subtasks || [];
  return {
    ...row,
    statusLabel: statusLabel(row.status, row.kind),
    overdue: isOverdue(row),
    frequencyLabel: FREQUENCY_LABELS[row.repeat?.frequency || FREQUENCY.ONCE],
    hasVoiceNote: Boolean(row.voiceNote?.storagePath),
    attachmentCount: (row.attachments || []).length,
    // Everybody still on it has said no — the task is owed and nobody is doing
    // it, which is a different thing from any of the three statuses.
    declined: isDeclined(row),
    // Somebody has not answered the handover yet.
    awaitingAcceptance: isAwaitingAcceptance(row),
    subtaskCount: subtasks.length,
    subtasksDone: subtasks.filter((st) => st.done).length,
    delegationCount: (row.delegations || []).length,
  };
}

// ===== Reading =====

/**
 * GET /api/tasks — one page of rows, plus the counters that must agree with it.
 */
const listTasks = asyncHandler(async (req, res) => {
  const filter = await buildQuery(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

  // Soonest deadline first, undated last — the order somebody would sort by
  // hand. `_id` breaks ties so paging cannot repeat or skip a row.
  const sort = { dueDate: 1, _id: -1 };

  const [rows, total, counters] = await Promise.all([
    Task.find(filter)
      .select(LIST_FIELDS)
      .populate('assignees.user', 'firstName lastName photo')
      .populate('createdBy', 'firstName lastName photo')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Task.countDocuments(filter),
    countersFor(filter),
  ]);

  res.json({
    // `can` per row, not just on the detail response.
    //
    // The list draws Accept / Decline / In progress / Complete straight on the
    // row, and it opens the same update box the detail page does — so it needs
    // the same answer to "what may this person do to this task". It is pure
    // in-memory work over at most 200 rows and no extra query, and the
    // alternative is the client re-deriving the rules, which is exactly the
    // split-brain this module was rebuilt to end.
    tasks: rows.map((row) => ({
      ...decorate(row),
      can: access.capabilitiesFor(req.user, row),
    })),
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 1,
    counters,
  });
});

/** GET /api/tasks/counters — the figures alone, for a badge. */
const taskCounters = asyncHandler(async (req, res) => {
  res.json(await countersFor(await buildQuery(req)));
});

/**
 * GET /api/tasks/:id — the task, its feed, and what this caller may do to it.
 *
 * `can` is computed on the SERVER (services/taskAccess.capabilitiesFor) and the
 * clients draw what they are told. Both used to derive the buttons themselves,
 * in two places, with two sets of bugs.
 */
const getTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);

  const task = await Task.findById(req.params.id)
    .populate('assignees.user', 'firstName lastName photo email')
    .populate('createdBy', 'firstName lastName photo')
    .populate('loopUsers', 'firstName lastName photo')
    .populate('linkedTask', 'code title status');
  if (!task) bad(res, 'That task no longer exists.', 404);
  access.assertCanSee(req.user, task);

  const updates = await TaskUpdate.find({ task: task._id })
    .populate('by', 'firstName lastName photo')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  res.json({
    task: decorate(task.toObject()),
    updates,
    can: access.capabilitiesFor(req.user, task),
  });
});

/** GET /api/tasks/:id/updates — the feed on its own, for paging it. */
const taskFeed = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id).select('createdBy assignees loopUsers assignedTo');
  if (!task) bad(res, 'That task no longer exists.', 404);
  access.assertCanSee(req.user, task);

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const before = req.query.before ? new Date(req.query.before) : null;
  const filter = { task: task._id };
  if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

  const updates = await TaskUpdate.find(filter)
    .populate('by', 'firstName lastName photo')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ updates });
});

// ===== Writing =====

/** Normalise a reminder rule off the wire; drop anything nonsensical. */
function cleanReminders(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({
      channel: REMINDER_CHANNELS.includes(r?.channel) ? r.channel : 'APP',
      amount: Math.max(0, Math.min(365, Number(r?.amount) || 0)),
      unit: REMINDER_UNITS.includes(r?.unit) ? r.unit : 'DAYS',
      when: REMINDER_WHENS.includes(r?.when) ? r.when : 'BEFORE',
    }))
    .filter((r) => r.amount > 0)
    // Two identical rules would fire once (they share an idempotence key) and
    // look like a bug. De-duplicate at the door.
    .filter((r, i, all) => all.findIndex((o) => o.channel === r.channel && o.amount === r.amount
      && o.unit === r.unit && o.when === r.when) === i)
    .slice(0, 10);
}

function cleanRepeat(raw) {
  const frequency = FREQUENCIES.includes(raw?.frequency) ? raw.frequency : FREQUENCY.ONCE;
  const out = { frequency };
  if (frequency === FREQUENCY.WEEKLY) {
    const days = (Array.isArray(raw?.weekdays) ? raw.weekdays : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    out.weekdays = [...new Set(days)].sort();
  }
  if (frequency === FREQUENCY.MONTHLY || frequency === FREQUENCY.YEARLY) {
    const d = Number(raw?.monthDay);
    if (Number.isInteger(d) && d >= 1 && d <= 31) out.monthDay = d;
  }
  if (frequency === FREQUENCY.YEARLY) {
    const m = Number(raw?.month);
    if (Number.isInteger(m) && m >= 1 && m <= 12) out.month = m;
  }
  if (/^\d{1,2}:\d{2}$/.test(String(raw?.time || ''))) out.time = raw.time;
  if (raw?.until) {
    const u = new Date(raw.until);
    if (!Number.isNaN(u.getTime())) out.until = u;
  }
  return out;
}

function cleanLinks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({ url: String(l?.url || '').trim(), label: String(l?.label || '').trim() }))
    .filter((l) => /^https?:\/\//i.test(l.url))
    .slice(0, 20);
}

/** Store uploaded files in GridFS and return the metadata rows. */
async function storeFiles(files, taskId, user) {
  const out = [];
  for (const file of files || []) {
    const { storagePath, sizeBytes } = await storage.saveBuffer({
      buffer: file.buffer,
      ownerType: 'task',
      ownerId: String(taskId),
      originalName: file.originalname,
    });
    out.push({
      name: file.originalname,
      storagePath,
      mimeType: file.mimetype,
      sizeBytes,
      kind: evidenceKindFor(file.mimetype, file.originalname),
      uploadedBy: user?._id,
      uploadedByName: personName(user),
    });
  }
  return out;
}

/**
 * Pull the voice note out of an upload.
 *
 * It arrives as a field named `voice` on the same multipart request as the
 * attachments, because a browser cannot send two requests atomically and a task
 * that saved without the recording somebody just made is a bad surprise.
 */
async function storeVoiceNote(files, taskId, user, durationMs) {
  const file = (files || []).find((f) => f.fieldname === 'voice');
  if (!file) return null;
  const { storagePath, sizeBytes } = await storage.saveBuffer({
    buffer: file.buffer,
    ownerType: 'task',
    ownerId: String(taskId),
    originalName: file.originalname || 'voice-note.webm',
  });
  return {
    storagePath,
    mimeType: file.mimetype || 'audio/webm',
    sizeBytes,
    durationMs: Number(durationMs) || undefined,
    recordedBy: user?._id,
    recordedByName: personName(user),
  };
}

/**
 * The body of an assign form, however it arrived.
 *
 * A multipart POST (one with a voice note or files) sends every field as a
 * string, so arrays and objects come through JSON-encoded. Parsing here rather
 * than at four call sites is the difference between one place that knows and
 * four that nearly do.
 */
function parseBody(req) {
  const b = { ...req.body };
  for (const key of ['assignees', 'loopUsers', 'reminders', 'repeat', 'links', 'mentions']) {
    if (typeof b[key] === 'string') {
      try { b[key] = JSON.parse(b[key]); } catch { /* leave it; validation will speak */ }
    }
  }
  return b;
}

/** Snapshot the people onto the task — names survive a departure. */
async function buildAssignees(userIds) {
  const ids = [...new Set((userIds || []).map(String))].filter(mongoose.Types.ObjectId.isValid);
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
  const profiles = await EmployeeProfile.find({ user: { $in: ids } })
    .select('user employeeCode').lean();
  const codeOf = new Map(profiles.map((p) => [String(p.user), p.employeeCode || '']));
  const byId = new Map(users.map((u) => [String(u._id), u]));
  // Preserve the order they were picked in: the first is the primary assignee.
  return ids
    .filter((id) => byId.has(id))
    .map((id) => ({
      user: id,
      name: personName(byId.get(id)),
      employeeCode: codeOf.get(id) || '',
      status: STATUS.PENDING,
    }));
}

/**
 * POST /api/tasks — hand work over, or ask for something.
 *
 * The direction rule decides which of those it is: see
 * services/taskAccess.resolveAssignmentKind. There is no separate "raise a
 * request" endpoint, because whether an ask is upward is a fact about the org
 * chart and not something a client should be trusted to assert.
 */
const createTask = asyncHandler(async (req, res) => {
  const body = parseBody(req);

  const title = String(body.title || '').trim();
  if (!title) bad(res, 'Give the task a title.');

  const wanted = (body.assignees || []).map(String).filter(Boolean);
  if (!wanted.length) bad(res, 'Choose at least one person for this task.');

  // Direction first — it decides what we are even creating.
  const { kind } = await access.resolveAssignmentKind(
    req.user,
    wanted,
    body.kind === KIND_REQUEST ? KIND_REQUEST : null
  );

  const assignees = await buildAssignees(wanted);
  if (!assignees.length) bad(res, 'None of the people chosen are available any more.');

  const dueDate = body.dueDate ? new Date(body.dueDate) : null;
  if (dueDate && Number.isNaN(dueDate.getTime())) bad(res, 'That due date is not a date.');

  const repeat = cleanRepeat(body.repeat);
  const recurring = repeat.frequency !== FREQUENCY.ONCE;
  // On a repeating task the date the assigner picked is the START, and the
  // first occurrence's deadline is computed from the schedule — the brief's
  // "this due date gets converted to a start date".
  const startDate = recurring ? (dueDate || new Date()) : undefined;

  const settings = await points.taskSettings();
  let pts = body.points === undefined || body.points === null || body.points === ''
    ? settings.defaultPoints
    : Number(body.points);
  if (!Number.isFinite(pts) || pts < 0) bad(res, 'Points must be a number, 0 or more.');
  pts = Math.min(MAX_TASK_POINTS, Math.round(pts));

  const reminders = body.reminders !== undefined
    ? cleanReminders(body.reminders)
    : settings.defaultReminders;

  const companyScope = await viewerCompanyScope(req);

  const task = new Task({
    kind,
    title,
    description: String(body.description || '').trim(),
    category: String(body.category || '').trim(),
    company: req.user.company || companyScope?.[0] || null,
    createdBy: req.user._id,
    createdByName: personName(req.user),
    assignees,
    loopUsers: [...new Set((body.loopUsers || []).map(String))]
      .filter(mongoose.Types.ObjectId.isValid),
    priority: TASK_PRIORITY.includes(body.priority) ? body.priority : DEFAULT_PRIORITY,
    points: kind === KIND_TASK ? pts : 0,
    dueDate: recurring ? undefined : dueDate,
    startDate,
    repeat,
    reminders,
    links: cleanLinks(body.links),
    linkedTask: engine.validId(body.linkedTask) ? body.linkedTask : undefined,
  });

  // The id has to exist before files can be filed under it.
  await task.save();

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  if (uploaded.length) task.attachments = await storeFiles(uploaded, task._id, req.user);
  const voice = await storeVoiceNote(req.files, task._id, req.user, body.voiceDurationMs);
  if (voice) task.voiceNote = voice;
  if (uploaded.length || voice) await task.save();

  await TaskUpdate.create({
    task: task._id,
    kind: 'CREATED',
    by: req.user._id,
    byName: personName(req.user),
    to: task.status,
    note: kind === KIND_REQUEST ? 'Raised this request.' : 'Set this task.',
  });

  // A repeating task becomes a schedule, and the worker mints the occurrences.
  if (recurring) {
    const schedule = await RecurringTask.create({
      title: task.title,
      description: task.description,
      category: task.category,
      priority: task.priority,
      points: task.points,
      assignees: assignees.map((a) => a.user),
      loopUsers: task.loopUsers,
      voiceNote: task.voiceNote,
      links: task.links,
      reminders: task.reminders,
      frequency: repeat.frequency,
      weekdays: repeat.weekdays,
      monthDay: repeat.monthDay,
      month: repeat.month,
      time: repeat.time || '18:00',
      startDate: startDate,
      until: repeat.until,
      company: task.company,
      createdBy: req.user._id,
      createdByName: personName(req.user),
    });
    task.recurringTask = schedule._id;
    // The row just created IS the first occurrence — mint its deadline now
    // rather than leaving a dateless task sitting until the worker next runs.
    const { firstDueDate } = require('../services/taskRecurrenceWorker');
    task.dueDate = firstDueDate(schedule);
    task.occurrenceKey = require('../services/taskRecurrenceWorker').occurrenceKeyFor(task.dueDate);
    await task.save();
  }

  notify.assigned(task, req.user).catch((e) => console.error('task notify failed:', e.message));

  res.status(201).json({ task: decorate(task.toObject()) });
});

/**
 * PATCH /api/tasks/:id — change the task itself.
 *
 * Only the assigner (or an admin). A doer changes STATUS, never the terms of
 * the job — see services/taskAccess.canEdit.
 */
const updateTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id);
  if (!task) bad(res, 'That task no longer exists.', 404);
  access.assertCanEdit(req.user, task);

  const body = parseBody(req);
  const changed = [];

  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) bad(res, 'A task needs a title.');
    if (t !== task.title) { task.title = t; changed.push('title'); }
  }
  if (body.description !== undefined) task.description = String(body.description).trim();
  if (body.category !== undefined) task.category = String(body.category).trim();
  if (body.priority !== undefined && TASK_PRIORITY.includes(body.priority)) {
    if (body.priority !== task.priority) { task.priority = body.priority; changed.push('priority'); }
  }

  if (body.points !== undefined && task.kind === KIND_TASK) {
    const p = Number(body.points);
    if (!Number.isFinite(p) || p < 0) bad(res, 'Points must be a number, 0 or more.');
    const rounded = Math.min(MAX_TASK_POINTS, Math.round(p));
    if (rounded !== task.points) {
      // Changing the figure after somebody has already been credited would put
      // the task and the credit out of step, and the credit is the one that is
      // money. Refuse rather than quietly disagree.
      if ((task.assignees || []).some((a) => a.pointsAwardedAt)) {
        bad(res, 'Points cannot be changed once somebody has completed this task and been credited.');
      }
      task.points = rounded;
      changed.push('points');
    }
  }

  if (body.dueDate !== undefined) {
    const d = body.dueDate ? new Date(body.dueDate) : null;
    if (d && Number.isNaN(d.getTime())) bad(res, 'That due date is not a date.');
    const was = task.dueDate ? new Date(task.dueDate).getTime() : null;
    if ((d ? d.getTime() : null) !== was) {
      if (was && d) task.extensionCount = (task.extensionCount || 0) + 1;
      task.dueDate = d || undefined;
      // A moved deadline is a fresh chase: the rules that already fired against
      // the old date must be allowed to fire again against the new one.
      task.firedReminders = [];
      changed.push('deadline');
    }
  }

  if (body.reminders !== undefined) {
    task.reminders = cleanReminders(body.reminders);
    task.firedReminders = [];
  }
  if (body.links !== undefined) task.links = cleanLinks(body.links);

  if (body.loopUsers !== undefined) {
    task.loopUsers = [...new Set((body.loopUsers || []).map(String))]
      .filter(mongoose.Types.ObjectId.isValid);
  }

  // Changing WHO is on it goes through the direction rule again — an edit must
  // not be a way around a check the create path makes.
  if (body.assignees !== undefined) {
    const wanted = (body.assignees || []).map(String).filter(Boolean);
    if (!wanted.length) bad(res, 'A task needs at least one person on it.');
    await access.resolveAssignmentKind(req.user, wanted, task.kind);
    const fresh = await buildAssignees(wanted);
    // Keep the progress of anybody who is staying: re-assigning a five-person
    // task must not reset the two people who have already finished.
    const existing = new Map((task.assignees || []).map((a) => [String(a.user), a]));
    task.assignees = fresh.map((f) => existing.get(String(f.user)) || f);
    changed.push('who is on it');
  }

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  if (uploaded.length) {
    task.attachments.push(...await storeFiles(uploaded, task._id, req.user));
  }
  const voice = await storeVoiceNote(req.files, task._id, req.user, body.voiceDurationMs);
  if (voice) task.voiceNote = voice;

  await task.save();

  if (changed.length) {
    await TaskUpdate.create({
      task: task._id,
      kind: 'EDITED',
      by: req.user._id,
      byName: personName(req.user),
      note: `Changed ${changed.join(', ')}.`,
    });
    notify.edited(task, req.user, `Changed ${changed.join(', ')}`)
      .catch((e) => console.error('task notify failed:', e.message));
  }

  res.json({ task: decorate(task.toObject()) });
});

/**
 * POST /api/tasks/:id/status — the one endpoint that moves anything.
 *
 * Body: { to, note, voiceDurationMs?, mentions? } plus optional files. Every
 * client uses this; there is no /start, /complete or /accept, because four
 * endpoints doing one thing is four places for the rule to be slightly
 * different.
 */
const changeStatus = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);

  const to = String(body.to || body.status || '').trim().toUpperCase();
  if (!TASK_STATUS.includes(to)) bad(res, 'That is not a status a task can be in.');

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  const files = uploaded.length ? await storeFiles(uploaded, req.params.id, req.user) : [];
  const voice = await storeVoiceNote(req.files, req.params.id, req.user, body.voiceDurationMs);

  const result = await engine.move({
    taskId: req.params.id,
    user: req.user,
    to,
    note: body.note,
    voiceNote: voice,
    files,
    mentions: (body.mentions || []).filter(mongoose.Types.ObjectId.isValid),
  });

  const task = await Task.findById(req.params.id)
    .populate('assignees.user', 'firstName lastName photo')
    .populate('createdBy', 'firstName lastName photo');

  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    unchanged: Boolean(result.unchanged),
    awarded: (result.awarded || []).map((a) => ({ points: a.points, credited: a.credited })),
  });
});

/** POST /api/tasks/:id/updates — a remark, with or without a recording. */
const addUpdate = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  const files = uploaded.length ? await storeFiles(uploaded, req.params.id, req.user) : [];
  const voice = await storeVoiceNote(req.files, req.params.id, req.user, body.voiceDurationMs);

  const { update } = await engine.comment({
    taskId: req.params.id,
    user: req.user,
    note: body.note,
    voiceNote: voice,
    files,
    mentions: (body.mentions || []).filter(mongoose.Types.ObjectId.isValid),
  });

  const full = await TaskUpdate.findById(update._id).populate('by', 'firstName lastName photo').lean();
  res.status(201).json({ update: full });
});

/**
 * POST /api/tasks/:id/accept — take it on.
 * POST /api/tasks/:id/decline — refuse it, with a reason.
 * POST /api/tasks/:id/delegate — pass your own piece to somebody else.
 *
 * The doer's three answers to being handed work. All three are IDENTITY-gated
 * inside the engine: only somebody actually on the task may use them, so an
 * assigner cannot accept on a doer's behalf (which would make acceptance
 * meaningless) and a bystander cannot pass on work that was never theirs.
 */
const acceptTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const { task, unchanged } = await engine.accept({
    taskId: req.params.id,
    user: req.user,
    note: parseBody(req).note,
  });
  res.json({ task: decorate(task.toObject()), can: access.capabilitiesFor(req.user, task), unchanged: Boolean(unchanged) });
});

const declineTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task } = await engine.decline({
    taskId: req.params.id,
    user: req.user,
    reason: body.reason || body.note,
  });
  res.json({ task: decorate(task.toObject()), can: access.capabilitiesFor(req.user, task) });
});

const delegateTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, delegatedTo } = await engine.delegate({
    taskId: req.params.id,
    user: req.user,
    to: body.to,
    note: body.note,
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    delegatedTo: { user: String(delegatedTo.user), name: delegatedTo.name },
  });
});

// ===== Subtasks =====

/**
 * POST /api/tasks/:id/subtasks — split it up.
 *
 * Body: `{ items: [{ title, assignee? }] }`, or `{ title, assignee? }` for one.
 * An item with no `assignee` is open to everybody on the task — the user's
 * "any assignee can do any subtask".
 */
const addSubtasks = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const items = Array.isArray(body.items) ? body.items : [body];
  const { task, added } = await engine.addSubtasks({
    taskId: req.params.id,
    user: req.user,
    items,
  });
  res.status(201).json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    added: added.length,
  });
});

/** PATCH /api/tasks/:id/subtasks/:subId — tick it off, or un-tick it. */
const setSubtask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, unchanged, progress } = await engine.setSubtaskDone({
    taskId: req.params.id,
    subtaskId: req.params.subId,
    user: req.user,
    done: body.done !== false && body.done !== 'false',
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    unchanged: Boolean(unchanged),
    progress,
  });
});

/** DELETE /api/tasks/:id/subtasks/:subId */
const removeSubtask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const { task } = await engine.removeSubtask({
    taskId: req.params.id,
    subtaskId: req.params.subId,
    user: req.user,
  });
  res.json({ task: decorate(task.toObject()), can: access.capabilitiesFor(req.user, task) });
});

/**
 * DELETE /api/tasks/:id — remove it.
 *
 * TWO KINDS OF REMOVAL, and the difference matters:
 *
 *   ARCHIVE (the default)  the row keeps its feed, its files and any points it
 *                          credited, and simply stops appearing anywhere. Open
 *                          to whoever set the task, to `tasks.manage`, and — at
 *                          the user's request, 2026-09-21 — to a SuperAdmin on
 *                          ANY task, whoever set it.
 *   PURGE (`?purge=1`)     really gone. SuperAdmin alone, and REFUSED once
 *                          points have been credited against it: the
 *                          IncentiveCredit would outlive the only record of
 *                          what it was for, and somebody would eventually ask.
 */
const deleteTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id);
  if (!task) bad(res, 'That task no longer exists.', 404);
  if (!access.canDelete(req.user, task)) {
    bad(res, 'Only the person who set this task, or a Super Admin, can remove it.', 403);
  }

  const purge = req.query.purge === '1' || req.query.purge === 'true';
  if (purge) {
    if (!access.canPurge(req.user)) bad(res, 'Only a Super Admin can delete a task for good.', 403);

    const credited = (task.assignees || []).filter((a) => a.pointsAwardedAt);
    if (credited.length) {
      bad(res,
        `${credited.length} person${credited.length === 1 ? ' has' : 's have'} already been credited `
        + 'points for this task. Reopen it first to take those back, then delete it.');
    }

    await TaskUpdate.deleteMany({ task: task._id });
    await Task.deleteOne({ _id: task._id });
    return res.json({ ok: true, purged: true, message: 'Deleted for good.' });
  }

  task.archived = true;
  await task.save();
  await TaskUpdate.create({
    task: task._id,
    kind: 'EDITED',
    by: req.user._id,
    byName: personName(req.user),
    note: 'Removed this task.',
  });
  res.json({ ok: true, purged: false, message: 'Removed.' });
});

// ===== Files =====

/** GET /api/tasks/:id/files/:fileId — stream one attachment or the voice note. */
const downloadFile = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That file is not there.', 404);
  const task = await Task.findById(req.params.id)
    .select('createdBy assignees assignedTo loopUsers attachments voiceNote');
  if (!task) bad(res, 'That file is not there.', 404);
  access.assertCanSee(req.user, task);

  let file = null;
  if (req.params.fileId === 'voice') {
    file = task.voiceNote
      ? { storagePath: task.voiceNote.storagePath, mimeType: task.voiceNote.mimeType, name: 'voice-note' }
      : null;
  } else {
    file = (task.attachments || []).find((a) => String(a._id) === String(req.params.fileId));
    if (!file) {
      // It may belong to an update rather than the task itself.
      const upd = await TaskUpdate.findOne({ task: task._id, 'files._id': req.params.fileId })
        .select('files voiceNote').lean();
      file = (upd?.files || []).find((f) => String(f._id) === String(req.params.fileId)) || null;
    }
  }
  if (!file) bad(res, 'That file is not there.', 404);

  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(file.name || 'file').replace(/"/g, '')}"`);
  const ok = await storage.streamTo(file.storagePath, res);
  if (!ok && !res.headersSent) bad(res, 'That file is not there.', 404);
});

/** GET /api/tasks/:id/updates/:updateId/voice — a remark's recording. */
const downloadUpdateVoice = asyncHandler(async (req, res) => {
  const upd = await TaskUpdate.findById(req.params.updateId).select('task voiceNote').lean();
  if (!upd?.voiceNote?.storagePath) bad(res, 'That recording is not there.', 404);
  const task = await Task.findById(upd.task).select('createdBy assignees assignedTo loopUsers');
  if (!task) bad(res, 'That recording is not there.', 404);
  access.assertCanSee(req.user, task);

  res.setHeader('Content-Type', upd.voiceNote.mimeType || 'audio/webm');
  const ok = await storage.streamTo(upd.voiceNote.storagePath, res);
  if (!ok && !res.headersSent) bad(res, 'That recording is not there.', 404);
});

// ===== Reference data =====

/**
 * GET /api/tasks/meta — everything the assign form needs, in one call.
 *
 * The form used to open with five requests in flight (people, categories,
 * templates, settings, my own permissions) and drew itself progressively as
 * they landed. On a phone against Android's five-connections-per-host that was
 * the difference between instant and a second and a half — the same trap the
 * app's launch sequence already had to be fixed for.
 */
const taskMeta = asyncHandler(async (req, res) => {
  const [people, categories, settings] = await Promise.all([
    User.find(await pickableUserFilter(req))
      .select('firstName lastName role photo')
      .sort({ firstName: 1 })
      .lean(),
    TaskCategory.find({ isActive: true, ...(req.user.company ? { $or: [{ company: req.user.company }, { company: null }] } : {}) })
      .select('name color')
      .sort({ name: 1 })
      .lean(),
    points.taskSettings(),
  ]);

  // Which of them may be given a task, and which may only be asked. Computed
  // once here so the picker can mark them, rather than the client guessing.
  const assignable = new Set(await access.assignableUserIds(req, people.map((p) => p._id)));
  const canAsk = new Set(await access.requestableUserIds(req));

  res.json({
    people: people.map((p) => ({
      _id: p._id,
      name: personName(p),
      role: p.role,
      photo: p.photo || null,
      canAssign: assignable.has(String(p._id)),
      canRequest: canAsk.has(String(p._id)),
    })),
    categories,
    priorities: TASK_PRIORITY,
    frequencies: FREQUENCIES.map((f) => ({ key: f, label: FREQUENCY_LABELS[f] })),
    weekdays: WEEKDAYS,
    reminderChannels: REMINDER_CHANNELS.map((c) => ({ key: c, label: REMINDER_CHANNEL_LABELS[c] })),
    reminderUnits: REMINDER_UNITS,
    defaultPoints: settings.defaultPoints,
    defaultReminders: settings.defaultReminders,
    pointsArePaid: settings.pointsToPool,
    isAdmin: access.seesEverything(req.user),
    // Renaming or removing a category is a SuperAdmin's alone — adding one is
    // everybody's. Sent so the form can offer the manage button rather than the
    // client guessing from a role string (see routes/taskRoutes).
    canManageCategories: req.user.role === 'SuperAdmin',
  });
});

/** POST /api/tasks/categories — the + beside the category picker. */
const createCategory = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) bad(res, 'Give the category a name.');
  if (name.length > 80) bad(res, 'That category name is too long.');

  const company = req.user.company || null;
  // Case-insensitive, so a second "sales" cannot appear beside "Sales" — the
  // exact problem models/TaskCategory exists to end.
  const existing = await TaskCategory.findOne({ company, name })
    .collation({ locale: 'en', strength: 2 });
  if (existing) return res.status(200).json({ category: existing, existed: true });

  const category = await TaskCategory.create({
    name,
    company,
    createdBy: req.user._id,
    createdByName: personName(req.user),
  });
  res.status(201).json({ category });
});

/**
 * GET /api/tasks/categories
 *
 * `?withCounts=1` adds how many tasks are filed under each — what the manage
 * list needs so a SuperAdmin about to remove one can see they are hiding the
 * label on 212 rows rather than on nothing.
 */
const listCategories = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.user.company) filter.$or = [{ company: req.user.company }, { company: null }];
  const categories = await TaskCategory.find(filter).sort({ name: 1 }).lean();

  if (req.query.withCounts !== '1' && req.query.withCounts !== 'true') {
    return res.json({ categories });
  }

  // One aggregation over the whole collection rather than a count per row: a
  // list of forty categories would otherwise be forty round trips.
  const used = await Task.aggregate([
    { $match: { archived: { $ne: true }, category: { $nin: [null, ''] } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  // Matched case-insensitively, the way the unique index treats them, so a
  // stray "sales" is counted against "Sales" rather than reading as unused.
  const counts = new Map(used.map((u) => [String(u._id).trim().toLowerCase(), u.count]));

  res.json({
    categories: categories.map((c) => ({
      ...c,
      taskCount: counts.get(String(c.name).trim().toLowerCase()) || 0,
    })),
  });
});

/**
 * PATCH /api/tasks/categories/:id — rename one, SuperAdmin only.
 *
 * The tasks store the NAME, not the id, so a rename has to carry the tasks with
 * it or two hundred rows are left filed under a label that no longer appears in
 * any picker. Done in one `updateMany` AFTER the category itself is saved: if
 * the save fails there is nothing to undo, and if the sweep fails the category
 * is right and the tasks can be swept again.
 */
const renameCategory = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) bad(res, 'Give the category a name.');
  if (name.length > 80) bad(res, 'That category name is too long.');

  const cat = await TaskCategory.findById(req.params.id);
  if (!cat) bad(res, 'That category is gone.', 404);

  const was = cat.name;
  if (was === name) return res.json({ category: cat, movedTasks: 0 });

  const clash = await TaskCategory.findOne({ company: cat.company, name, _id: { $ne: cat._id } })
    .collation({ locale: 'en', strength: 2 });
  if (clash) bad(res, `There is already a category called "${clash.name}".`);

  cat.name = name;
  await cat.save();

  const swept = await Task.updateMany(
    { category: was },
    { $set: { category: name } }
  );
  res.json({ category: cat, movedTasks: swept.modifiedCount || 0 });
});

/**
 * How many tasks are ON this person right now — the sidebar badge.
 *
 * Their own open rows, overdue ones included. Called by approvalController's
 * one-shot counts fan-out, so it must be a single cheap query and must never
 * throw: a badge that fails takes the whole counts response down with it.
 *
 * Counted from `assignees.status` rather than the task's rolled-up status, so a
 * five-person task that two people have finished still badges for the three who
 * have not.
 */
async function countMyOpenTasks(req) {
  return Task.countDocuments({
    archived: { $ne: true },
    assignees: {
      $elemMatch: {
        user: req.user._id,
        status: { $in: [STATUS.PENDING, STATUS.IN_PROGRESS] },
      },
    },
  });
}

/**
 * DELETE /api/tasks/categories/:id — SuperAdmin only.
 *
 * TWO DIFFERENT DELETES, and which one happens depends on whether anything is
 * filed under it:
 *
 *   NOTHING USES IT   the row is really removed. A category somebody created by
 *                     mistake — "temp", a typo — should disappear, not sit
 *                     deactivated forever occupying its own name in the unique
 *                     index so the right spelling cannot be created.
 *   SOMETHING USES IT  it is DEACTIVATED, and the tasks keep the label they
 *                     were filed under. Wiping `category` off two hundred rows
 *                     to tidy a dropdown is destroying records to fix a list.
 *
 * `?moveTo=<name>` refiles them first, which is the honest way to merge two
 * categories that should always have been one. `?force=1` removes the row even
 * though it is in use, leaving the tasks' label as free text — offered because
 * a SuperAdmin tidying a list knows better than this handler does, but never
 * the default.
 */
const deleteCategory = asyncHandler(async (req, res) => {
  const cat = await TaskCategory.findById(req.params.id);
  if (!cat) bad(res, 'That category is already gone.', 404);

  const moveTo = String(req.query.moveTo || '').trim();
  let moved = 0;

  if (moveTo) {
    if (moveTo === cat.name) bad(res, 'That is the same category.');
    const target = await TaskCategory.findOne({ company: cat.company, name: moveTo })
      .collation({ locale: 'en', strength: 2 });
    if (!target) bad(res, `There is no category called "${moveTo}" to move these into.`);
    const swept = await Task.updateMany({ category: cat.name }, { $set: { category: target.name } });
    moved = swept.modifiedCount || 0;
  }

  const stillUsed = await Task.countDocuments({ category: cat.name, archived: { $ne: true } });
  const force = req.query.force === '1' || req.query.force === 'true';

  if (stillUsed > 0 && !force) {
    // Hidden from every picker and filter, but the tasks keep reading right.
    cat.isActive = false;
    await cat.save();
    return res.json({
      ok: true,
      removed: false,
      hidden: true,
      movedTasks: moved,
      stillUsed,
      message: `Hidden. ${stillUsed} task${stillUsed === 1 ? '' : 's'} stay filed under "${cat.name}".`,
    });
  }

  await TaskCategory.deleteOne({ _id: cat._id });
  res.json({
    ok: true,
    removed: true,
    hidden: false,
    movedTasks: moved,
    stillUsed,
    message: moved
      ? `Removed. ${moved} task${moved === 1 ? '' : 's'} moved to "${moveTo}".`
      : 'Removed.',
  });
});

module.exports = {
  listTasks,
  taskCounters,
  getTask,
  taskFeed,
  createTask,
  updateTask,
  changeStatus,
  addUpdate,
  acceptTask,
  declineTask,
  delegateTask,
  addSubtasks,
  setSubtask,
  removeSubtask,
  deleteTask,
  downloadFile,
  downloadUpdateVoice,
  taskMeta,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  countMyOpenTasks,
  // shared with the dashboard controller
  buildQuery,
  countersFor,
  decorate,
  parseBody,
  storeFiles,
  storeVoiceNote,
  cleanReminders,
  cleanRepeat,
  cleanLinks,
  buildAssignees,
  personName,
};
