const mongoose = require('mongoose');
const {
  KIND_TASK,
  TASK_KINDS,
  STATUS,
  TASK_STATUS,
  ACCEPTANCE,
  ACCEPTANCE_STATES,
  TASK_PRIORITY,
  DEFAULT_PRIORITY,
  DEFAULT_TASK_POINTS,
  MAX_TASK_POINTS,
  FREQUENCY,
  FREQUENCIES,
  REMINDER_CHANNELS,
  REMINDER_UNITS,
  REMINDER_WHENS,
  EVIDENCE_KINDS,
  LEGACY_STATUS_MAP,
  normaliseStatus,
  isTerminal,
} = require('../config/tasks');
const { stampCode } = require('../services/sequence');

/**
 * A job somebody has been handed, or a question somebody has asked upward.
 *
 * REWRITTEN 2026-09-21 — same collection, same `_id`s, a third of the fields.
 * The version this replaces carried an embedded copy of a workflow definition,
 * a dependency graph, a checklist, custom fields, an evidence contract, a
 * geofence and a per-outcome incentive split. What a task actually needs to do
 * is say who is doing what by when, let them say how it is going, and be
 * counted afterwards. Everything here earns its place against that.
 *
 * WHAT DID NOT CHANGE. `title`, `description`, `assignedTo`, `priority`,
 * `dueDate`, `createdBy`, `company`, `code` and `archived` mean exactly what
 * they did, and `assignees` keeps the same shape for the fields that survived.
 * Removed fields are simply no longer read: nothing drops a column, so an
 * un-migrated row is still a valid document and scripts/migrateTasksV3.js can
 * be run (and re-run) at leisure. The four legacy statuses and the twelve from
 * the last rework are still ACCEPTED on write and normalised on save, so an
 * Android build speaking the old vocabulary keeps working.
 *
 * TWO KINDS, ONE COLLECTION. `kind` is TASK (handed down or across) or REQUEST
 * (asked upward). They share every field, every screen and every query; a
 * request simply earns no points and is excluded from scoring. Splitting them
 * into two collections would have meant two list endpoints, two detail pages
 * and two notification paths to say almost the same thing. See config/tasks.js.
 *
 * THE HEADLINE STATUS IS A ROLL-UP, NEVER TYPED. A task may be on three people.
 * `status` is recomputed from `assignees[].status` on every save: all done →
 * COMPLETED, anybody started → IN_PROGRESS, otherwise PENDING. A cancellation
 * is the one status set directly, because it is the assigner overruling
 * everybody at once.
 */

// ===== Embedded shapes =====

/**
 * One file on the task — hung there by the assigner, or handed back with an
 * update. The BYTES live in GridFS via services/storage.js; this is metadata.
 *
 * `update` points at the TaskUpdate row it arrived with, so the feed can render
 * the file under the remark it came with rather than in a separate pile. Null
 * on the assigner's own attachments, which belong to the task itself.
 */
const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true },
    sizeBytes: Number,
    kind: { type: String, enum: EVIDENCE_KINDS, default: 'document' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedByName: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
    update: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskUpdate' },
  },
  { _id: true }
);

/**
 * A recorded explanation.
 *
 * The one feature the brief would not do without: an assigner who can SAY what
 * they mean in ten seconds does not get asked half an hour of questions, and a
 * doer can answer in whatever language they think in. Stored exactly like an
 * attachment (GridFS + metadata) but as its own field rather than one of the
 * files, because a voice note has a player and a duration and is always shown
 * first, and hunting for it inside an attachment array by MIME type is the kind
 * of thing that works until somebody uploads an .mp3 of something else.
 */
const voiceNoteSchema = new mongoose.Schema(
  {
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true, default: 'audio/webm' },
    sizeBytes: Number,
    durationMs: Number,
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** A link the work needs — a sheet, a drive folder, a ticket. */
const linkSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
  },
  { _id: true }
);

/**
 * One person on the task, and where they have got to.
 *
 * Each carries their OWN status, because a task on three people is three jobs
 * and one of them being finished is worth seeing. Names and codes are
 * snapshots, as everywhere else in this portal: the row has to keep reading
 * correctly after somebody leaves, and leavers are dropped from every picker.
 */
const assigneeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    status: {
      type: String,
      enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP)],
      default: STATUS.PENDING,
    },
    startedAt: Date,
    completedAt: Date,
    /**
     * Did their part land after the deadline? Frozen at the moment they
     * finished, NOT re-derived on read: extending a task afterwards must not
     * retroactively turn a late delivery into a punctual one, and this figure
     * is what the dashboard's In Time / Delayed split counts.
     */
    completedLate: { type: Boolean, default: false },

    /**
     * Have they taken it on? A SEPARATE AXIS from `status` — see
     * config/tasks.ACCEPTANCE for why this is not a fourth status.
     *
     * Starting work implies acceptance (the engine sets it), so nobody is ever
     * chased for an acknowledgement of a job they have already done.
     */
    acceptance: { type: String, enum: ACCEPTANCE_STATES, default: ACCEPTANCE.AWAITING },
    acceptedAt: Date,
    declinedAt: Date,
    /** Why they said no. Required by the engine — a refusal with no reason
     *  cannot be acted on by the person who has to reassign it. */
    declineReason: { type: String, trim: true, maxlength: 500 },

    /**
     * Who handed it to them, when it arrived by delegation rather than from the
     * assigner. The full trail is `Task.delegations`; this is the one hop, kept
     * on the row so a list can say "via Megha" without a join.
     */
    delegatedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    delegatedFromName: { type: String, trim: true },

    /** The IncentiveCredit their points became, if points were credited. */
    creditRef: { type: mongoose.Schema.Types.ObjectId, ref: 'IncentiveCredit' },
    pointsAwarded: { type: Number, default: 0 },
    pointsAwardedAt: Date,
  },
  { _id: true }
);

/**
 * One piece of a task, small enough not to be a task of its own.
 *
 * Added 2026-09-21 (second pass), at the user's request. Deliberately EMBEDDED
 * rather than child Task documents:
 *
 *   - a task page stays ONE query, which is the property the whole module is
 *     built around;
 *   - a subtask has no deadline, no points, no reminders and no feed of its
 *     own, so a full Task would be a document with nine tenths of its fields
 *     empty;
 *   - "any assignee can do any subtask" is trivial when they hang off the
 *     parent and awkward when they are separate rows with their own assignees.
 *
 * TWO KINDS, and the difference is one nullable field:
 *   assignee set    that person's piece. Only they (or the assigner) tick it.
 *   assignee null   ANYBODY on the parent task can tick it — the user's
 *                   "or any assinee can do any subtask".
 *
 * Somebody named on a subtask can SEE the parent task even if they are not on
 * it (services/taskAccess), or a subtask assigned to them would be invisible.
 */
const subtaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 300 },
    // Null = open to everybody on the task.
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assigneeName: { type: String, trim: true },
    done: { type: Boolean, default: false },
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    doneByName: { type: String, trim: true },
    doneAt: Date,
    order: { type: Number, default: 0 },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedByName: { type: String, trim: true },
  },
  { _id: true }
);

/**
 * One hop of a task changing hands.
 *
 * Append only. The trail matters because the person who was FIRST given the
 * task keeps being notified of everything that happens to it afterwards
 * (`originalAssignees` below) — and when somebody asks why, this is the answer.
 */
const delegationSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromName: { type: String, trim: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toName: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

/** One reminder rule. The wording and the maths live in config/tasks.js. */
const reminderSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: REMINDER_CHANNELS, default: 'APP' },
    amount: { type: Number, min: 0, default: 1 },
    unit: { type: String, enum: REMINDER_UNITS, default: 'DAYS' },
    when: { type: String, enum: REMINDER_WHENS, default: 'BEFORE' },
  },
  { _id: false }
);

/**
 * How often this repeats.
 *
 * A recurring task's `dueDate` is the deadline of the CURRENT occurrence; the
 * schedule that mints the next one is models/RecurringTask. This block is what
 * the assigner typed, kept on the task so the row can say "Weekly · every Fri"
 * without a join.
 */
const repeatSchema = new mongoose.Schema(
  {
    frequency: { type: String, enum: FREQUENCIES, default: FREQUENCY.ONCE },
    /** For WEEKLY: which days, as `Date.getDay()` indexes (0 = Sunday). */
    weekdays: { type: [Number], default: undefined },
    /** For MONTHLY: which day of the month. 31 lands on the last day of short months. */
    monthDay: Number,
    /** For YEARLY: 1-12 with monthDay. */
    month: Number,
    /** "HH:mm", 24h, in the portal's timezone. The time of day it falls due. */
    time: { type: String, trim: true },
    /** Stop minting occurrences after this. Null = forever. */
    until: Date,
  },
  { _id: false }
);

// ===== The task =====

const taskSchema = new mongoose.Schema(
  {
    // The quotable reference — TSK-2026-00042 — minted once from the atomic
    // counter (services/sequence) so two created in the same second cannot
    // collide. Never rewritten: a code quoted in an email keeps pointing here.
    code: { type: String, trim: true, unique: true, sparse: true },

    kind: { type: String, enum: TASK_KINDS, default: KIND_TASK, index: true },

    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, trim: true, maxlength: 5000 },

    // The department or project this belongs under. Free text against
    // models/TaskCategory, which anybody can add to from the assign form —
    // "create as many categories according to your business".
    category: { type: String, trim: true, index: true },

    // The company wall's field, snapshot from the assigner on save so a list
    // query never has to join through EmployeeProfile. See utils/employeeScope.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },

    // ===== People =====
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    createdByName: { type: String, trim: true },
    // The primary assignee — assignees[0]. Maintained by this model, and the
    // field every legacy query, the calendar and the company wall still read.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignees: { type: [assigneeSchema], default: [] },
    // "Keep in loop" — a junior's manager, who sees the task and hears about
    // every move on it without being answerable for any of it.
    loopUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

    /**
     * WHO FIRST GOT THIS, whatever has happened to it since.
     *
     * Stamped once, on creation, and never rewritten. When somebody delegates a
     * task onward they drop out of `assignees` — but the user's rule is that
     * "the user who got the task in the beginning will receive notification for
     * every update", so this is the list every notification adds on top of its
     * own audience (services/taskNotify.recipients).
     *
     * It is NOT the same as `loopUsers`: the loop is a choice the assigner made
     * and can undo, this is a fact about the task's history and cannot be.
     * Keeping them apart is what stops "take Megha off the loop" also silencing
     * the person who originally owned the job.
     */
    originalAssignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // ===== Splitting it up =====
    /** The pieces. See subtaskSchema — embedded, capped, one query. */
    subtasks: { type: [subtaskSchema], default: [] },
    /** The append-only trail of the task changing hands. */
    delegations: { type: [delegationSchema], default: [] },

    // ===== State =====
    status: {
      type: String,
      enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP)],
      default: STATUS.PENDING,
      index: true,
    },
    priority: { type: String, enum: TASK_PRIORITY, default: DEFAULT_PRIORITY, index: true },

    /**
     * What this is worth, in points, to EACH person on it.
     *
     * One figure, no hidden arithmetic: "this task is worth 100 points" reads
     * the same whether it is on one person or four, and an assigner who wants
     * a four-way split types 25. Points are the portal's single company-wide
     * currency (models/IncentiveCredit, valued by Setting.incentive
     * .rupeePerPoint), so the figure means the same here as it does in the
     * rolling and billing incentives.
     *
     * A REQUEST always carries 0 — asking your manager for a file is not work
     * you have done (see the pre-validate hook).
     */
    points: { type: Number, min: 0, max: MAX_TASK_POINTS, default: DEFAULT_TASK_POINTS },

    // ===== Dates =====
    startDate: Date,
    dueDate: { type: Date, index: true },
    // What the deadline was when the task was set, kept when somebody moves it
    // so "this was extended twice" is answerable from the row.
    originalDueDate: Date,
    extensionCount: { type: Number, default: 0 },
    assignedAt: { type: Date, default: Date.now },
    startedAt: Date,
    completedAt: Date,
    /** The roll-up of assignees[].completedLate — see that field's note. */
    completedLate: { type: Boolean, default: false },

    // ===== Content =====
    voiceNote: { type: voiceNoteSchema, default: undefined },
    attachments: { type: [attachmentSchema], default: [] },
    links: { type: [linkSchema], default: [] },

    // ===== Chasing =====
    reminders: { type: [reminderSchema], default: [] },
    /**
     * Which reminder rules have already fired, as `config/tasks.reminderKey`
     * strings. The worker's idempotence lives here — a restart must not replay
     * a day of notifications at somebody, which is exactly the trap the
     * attendance push worker hit and had to be fixed for.
     */
    firedReminders: { type: [String], default: [] },

    // ===== Recurrence =====
    repeat: { type: repeatSchema, default: () => ({ frequency: FREQUENCY.ONCE }) },
    recurringTask: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringTask', index: true },
    // The occurrence this instance is for, as an IST day key. The generator's
    // idempotence key: a worker restart cannot mint the same day twice.
    occurrenceKey: { type: String, trim: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskTemplate' },

    // ===== Requests =====
    // The task this request is about, when it was raised from one ("I need the
    // April figures to finish T-9109"). Null on a standalone ask.
    linkedTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },

    // ===== Bookkeeping =====
    updateCount: { type: Number, default: 0 },
    // Why it was cancelled or reopened. On the row, so a list can say it
    // without opening the feed.
    stateNote: { type: String, trim: true, maxlength: 1000 },
    archived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// ===== Indexes =====
// The compounds behind the five lists this module has, and nothing else: an
// index nobody queries is a write nobody needed.
taskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });   // "my open tasks, soonest first"
taskSchema.index({ 'assignees.user': 1, status: 1, dueDate: 1 }); // the same for a co-assignee
taskSchema.index({ createdBy: 1, status: 1, dueDate: 1 });    // "what I delegated"
taskSchema.index({ company: 1, kind: 1, status: 1, dueDate: 1 }); // every walled admin list
taskSchema.index({ status: 1, dueDate: 1 });                  // the overdue sweep
taskSchema.index({ loopUsers: 1, status: 1 });                // "tasks I am kept in loop on"
// Somebody who owns a SUBTASK sees the parent even when they are not on it
// (services/taskAccess.visibleFilter), so that lookup needs an index of its own.
taskSchema.index({ 'subtasks.assignee': 1, status: 1 });
// …and so does "what was originally mine", which is how a delegator keeps
// finding the work they handed on.
taskSchema.index({ originalAssignees: 1, status: 1 });
taskSchema.index({ recurringTask: 1, occurrenceKey: 1 }, { unique: true, sparse: true });
taskSchema.index({ title: 'text', description: 'text', code: 'text' });

// ===== Hooks =====

taskSchema.pre('validate', function normalise(next) {
  // Accept whatever vocabulary came in — see config/tasks.normaliseStatus.
  const norm = normaliseStatus(this.status);
  if (norm) this.status = norm;
  for (const a of this.assignees || []) {
    const an = normaliseStatus(a.status);
    if (an) a.status = an;
  }

  // A request is an ask, not work: it never carries points and never scores.
  if (this.kind !== KIND_TASK) this.points = 0;

  // The primary assignee IS the first one on the list. Kept in step here
  // rather than at each call site, because every path that touches the array
  // would otherwise have to remember.
  if (this.assignees?.length) {
    this.assignedTo = this.assignees[0].user;
  } else if (this.assignedTo) {
    // A task written by an older client that only knows `assignedTo`.
    this.assignees = [{ user: this.assignedTo, status: this.status || STATUS.PENDING }];
  }

  if (this.dueDate && !this.originalDueDate) this.originalDueDate = this.dueDate;

  // Stamped ONCE, on the first save, and never rewritten — see the field's own
  // note. `isNew` rather than "is it empty", because a task whose original
  // assignees have all since delegated away would otherwise be re-stamped with
  // whoever holds it now, silently rewriting exactly the history it exists to
  // keep.
  if (this.isNew && !this.originalAssignees?.length) {
    this.originalAssignees = (this.assignees || []).map((a) => a.user).filter(Boolean);
  }

  next();
});

taskSchema.pre('validate', function rollUpStatus(next) {
  // CANCELLED is the assigner overruling everybody — never derived away.
  if (this.status === STATUS.CANCELLED) return next();

  const people = this.assignees || [];
  if (!people.length) return next();

  // Somebody who has been taken off it, or who DECLINED it, must not hold the
  // roll-up open: a five-person task where one person said no and the other
  // four finished is a finished task, and leaving it IN_PROGRESS for ever is
  // how a list fills with work nobody is doing. A fully-declined task falls
  // back to the whole list and lands on PENDING, which is right — it is still
  // owed, and `config/tasks.isDeclined` is what says so on screen.
  const live = people.filter(
    (a) => a.status !== STATUS.CANCELLED && a.acceptance !== ACCEPTANCE.REJECTED
  );
  const pool = live.length ? live : people;

  if (pool.every((a) => a.status === STATUS.COMPLETED)) {
    this.status = STATUS.COMPLETED;
    // The task finished when its LAST person did.
    const times = pool.map((a) => a.completedAt).filter(Boolean).map((d) => new Date(d).getTime());
    this.completedAt = times.length ? new Date(Math.max(...times)) : (this.completedAt || new Date());
    // Late if ANYBODY was late. One person delivering on time does not make a
    // task that was waiting a week on somebody else punctual.
    this.completedLate = pool.some((a) => a.completedLate);
  } else if (pool.some((a) => a.status === STATUS.IN_PROGRESS || a.status === STATUS.COMPLETED)) {
    this.status = STATUS.IN_PROGRESS;
    this.completedAt = undefined;
    this.completedLate = false;
    if (!this.startedAt) {
      const starts = pool.map((a) => a.startedAt).filter(Boolean).map((d) => new Date(d).getTime());
      if (starts.length) this.startedAt = new Date(Math.min(...starts));
    }
  } else {
    this.status = STATUS.PENDING;
    this.completedAt = undefined;
    this.completedLate = false;
  }
  next();
});

// TSK-YYYY-NNNNN, from the same counter the voucher and expense codes use.
taskSchema.pre('save', stampCode('TSK', 'createdAt'));

// ===== Helpers =====
// Instance methods rather than free functions because every caller has the
// document in hand, and `task.isDoer(user)` is the sentence the guard wants.

/** Is this user one of the people the task is on? */
taskSchema.methods.isDoer = function isDoer(userId) {
  const id = String(userId || '');
  return (this.assignees || []).some((a) => String(a.user?._id || a.user) === id);
};

/** Did this user set it? (An admin is treated as an assigner by taskAccess.) */
taskSchema.methods.isAssigner = function isAssigner(userId) {
  return String(this.createdBy?._id || this.createdBy || '') === String(userId || '');
};

/** This user's own row on the task, or null. */
taskSchema.methods.assigneeFor = function assigneeFor(userId) {
  const id = String(userId || '');
  return (this.assignees || []).find((a) => String(a.user?._id || a.user) === id) || null;
};

/** Everyone who should hear about a move on this task. */
/**
 * Everyone who should hear about a move on this task.
 *
 * FIVE groups, and the last two are the ones that are easy to forget:
 *   the assigner · the people on it · the loop ·
 *   whoever FIRST had it (they keep hearing about it after delegating — the
 *   user's rule) · anybody who owns a subtask but is not otherwise on the task.
 */
taskSchema.methods.audience = function audience() {
  const ids = new Set();
  if (this.createdBy) ids.add(String(this.createdBy._id || this.createdBy));
  for (const a of this.assignees || []) ids.add(String(a.user?._id || a.user));
  for (const u of this.loopUsers || []) ids.add(String(u._id || u));
  for (const u of this.originalAssignees || []) ids.add(String(u._id || u));
  for (const st of this.subtasks || []) {
    if (st.assignee) ids.add(String(st.assignee._id || st.assignee));
  }
  return [...ids].filter(Boolean);
};

/** Is this user on a subtask, without being on the task itself? */
taskSchema.methods.ownsSubtask = function ownsSubtask(userId) {
  const id = String(userId || '');
  return (this.subtasks || []).some((st) => String(st.assignee?._id || st.assignee || '') === id);
};

/** How many pieces are done, for a progress line. */
taskSchema.methods.subtaskProgress = function subtaskProgress() {
  const all = this.subtasks || [];
  return { done: all.filter((st) => st.done).length, total: all.length };
};

taskSchema.methods.isTerminal = function terminal() {
  return isTerminal(this.status);
};

module.exports = mongoose.model('Task', taskSchema);
